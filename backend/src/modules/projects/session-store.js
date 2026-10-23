// Persists schema-valid task sessions in the selected project's Node-managed runtime storage.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(require("../../../../schemas/core/common.schema.json"));
ajv.addSchema(require("../../../../schemas/core/agent.schema.json"));
const validate = ajv.compile(require("../../../../schemas/project/session.schema.json"));

// Rejects unsafe task/session path components before accessing project storage.
function assertIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new ConfigurationError("Session identifiers must be safe single path components.");
}

// Reports project or persisted session identity conflicts without modifying existing artifacts.
function conflict() {
  return Object.assign(new ConfigurationError("Session does not belong to the selected project or task."), { code: "PROJECT_CONTEXT_CONFLICT", statusCode: 409 });
}

// Creates an idempotent session store bound to exactly one application's project and root.
export function createSessionStore({ projectId, fileService } = {}) {
  assertIdentifier(projectId);
  if (!fileService?.readFile || !fileService?.atomicCreate) throw new ConfigurationError("Session storage requires a root-bound FileService.");
  // Validates both the session contract and its root-local identity before reuse.
  function check(session, sessionId, taskId) {
    if (!validate(session)) throw new ConfigurationError(`Invalid session record: ${ajv.errorsText(validate.errors)}`);
    if (session.id !== sessionId || session.project_id !== projectId || (taskId !== undefined && session.task_id !== taskId)) throw conflict();
    return Object.freeze(session);
  }
  // Reads and validates an existing session without treating corrupt records as missing.
  async function get(sessionId) {
    assertIdentifier(sessionId);
    let content;
    try { content = await fileService.readFile({ path: `${statePath()}/nf/sessions/${sessionId}.json` }); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    return check(JSON.parse(content), sessionId, sessionId.slice("SESSION-".length));
  }
  // Creates one active session per task, preserving existing lifecycle fields on retries and races.
  async function ensureForTask({ task_id: taskId, project_id: requestedProjectId } = {}) {
    assertIdentifier(taskId);
    if (requestedProjectId !== undefined && requestedProjectId !== projectId) throw conflict();
    const sessionId = `SESSION-${taskId}`;
    const existing = await get(sessionId);
    if (existing) return check(existing, sessionId, taskId);
    const session = check({ id: sessionId, project_id: projectId, task_id: taskId, status: "active", started_at: new Date().toISOString() }, sessionId, taskId);
    try { await fileService.atomicCreate({ path: `${statePath()}/nf/sessions/${sessionId}.json`, content: JSON.stringify(session) }); }
    catch (error) {
      if (error.code !== "FILE_ALREADY_EXISTS") throw error;
      const concurrent = await get(sessionId);
      return check(concurrent, sessionId, taskId);
    }
    return session;
  }
  return Object.freeze({ get, ensureForTask });
}

// Shares production task/session preparation between real supervisors and routing verification.
export function createTaskSessionPreparation({ projectId, taskStore, fileService } = {}) {
  const sessions = createSessionStore({ projectId, fileService });
  // Rejects contradictory project context before task writes and repairs interrupted session preparation.
  return async function prepareTaskSession({ task_id: taskId, project_id: requestedProjectId, ticket } = {}) {
    assertIdentifier(taskId);
    if ((requestedProjectId !== undefined && requestedProjectId !== projectId) || (ticket?.project_id !== undefined && ticket.project_id !== projectId)) throw conflict();
    if (!taskStore.get(taskId)) taskStore.create({ id: taskId, type: "custom", title: ticket?.title ?? taskId, description: ticket?.objective ?? "", acceptance_criteria: ticket?.acceptance_criteria ?? [], status: "pending", created_at: new Date().toISOString() });
    const session = await sessions.ensureForTask({ task_id: taskId, project_id: projectId });
    return { session_id: session.id };
  };
}
