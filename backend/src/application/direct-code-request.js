// Saves a direct coding request so Supervisor can dispatch the owner's exact text without creating a sprint ticket.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Creates a File Service backed entry point for coding directly from the sprint dashboard.
export function createDirectCodeRequest({ fileService, integration, checkpoints, projectId: expectedProjectId, projectLogger = () => {}, clock = () => new Date() } = {}) {
  if (typeof fileService?.atomicCreate !== "function" || typeof fileService?.atomicWrite !== "function" || typeof fileService?.readFile !== "function") throw new ConfigurationError("Direct code requests require File Service storage.");
  if (typeof integration?.submitTicket !== "function") throw new ConfigurationError("Direct code requests require Supervisor dispatch.");
  if (typeof checkpoints?.load !== "function" || typeof checkpoints?.listPending !== "function") throw new ConfigurationError("Direct code requests require checkpoint storage.");
  const running = new Set();
  return Object.freeze({ run, resume, listPending });

  // Persists the input and outcome while Supervisor selects and runs an available coder.
  async function run({ projectId, sprintId, text } = {}) {
    if (typeof projectId !== "string" || !projectId.trim()) throw invalid("project_id is required.");
    if (expectedProjectId && projectId !== expectedProjectId) throw invalid("project_id does not match the active project.");
    if (typeof text !== "string" || !text.trim() || text.length > 50000) throw invalid("Code request must contain 1–50000 characters.");
    if (sprintId !== undefined && (typeof sprintId !== "string" || !sprintId.trim())) throw invalid("sprint_id is invalid.");
    const taskId = `CODE-${clock().getTime()}-${randomUUID()}`;
    const inputPath = `.forge/runtime/nf/code-requests/${taskId}.json`;
    const input = { task_id: taskId, project_id: projectId, required_role: "coder", mode: "direct_code", ...(sprintId ? { sprint_id: sprintId } : {}), text, created_at: clock().toISOString() };
    await fileService.atomicCreate({ path: inputPath, content: `${JSON.stringify(input, null, 2)}\n` });
    return dispatch(input);
  }

  // Resumes the exact saved coding request and provider session from an unfinished checkpoint.
  async function resume({ projectId, taskId } = {}) {
    if (projectId !== expectedProjectId || typeof taskId !== "string" || !/^CODE-[A-Za-z0-9-]+$/.test(taskId)) throw invalid("Invalid direct code task or project.");
    const input = await readInput(taskId);
    if (!input || input.project_id !== projectId || input.mode !== "direct_code" || input.task_id !== taskId) throw invalid("Direct code request not found.");
    const checkpoint = await checkpoints.load(taskId);
    if (!checkpoint || checkpoint.status === "completed") throw invalid("No unfinished checkpoint is available.");
    return dispatch(input, checkpoint);
  }

  // Lists unfinished direct-code checkpoints so dashboard buttons recover after reconnects.
  async function listPending({ projectId, sprintId } = {}) {
    if (projectId !== expectedProjectId) throw invalid("project_id does not match the active project.");
    const pending = [];
    for (const checkpoint of await checkpoints.listPending()) {
      if (!checkpoint.task_id?.startsWith("CODE-")) continue;
      const input = await readInput(checkpoint.task_id);
      if (input?.project_id !== projectId || input.mode !== "direct_code" || (sprintId && input.sprint_id !== sprintId)) continue;
      pending.push({ task_id: input.task_id, sprint_id: input.sprint_id ?? null, last_completed_turn: checkpoint.last_completed_turn ?? 0, last_tool: checkpoint.last_tool ?? null, updated_at: checkpoint.updated_at ?? null, status: running.has(input.task_id) ? "running" : "resumable" });
    }
    return pending.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  // Loads the owner-authored request without deriving work from a new chat message.
  async function readInput(taskId) {
    try { return JSON.parse(await fileService.readFile({ path: `.forge/runtime/nf/code-requests/${taskId}.json` })); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  // Dispatches a new or resumed request while preventing duplicate execution of one task.
  async function dispatch(input, checkpoint = null) {
    const { task_id: taskId } = input;
    if (running.has(taskId)) throw Object.assign(invalid("Direct code task is already running."), { statusCode: 409 });
    running.add(taskId);
    try { return await execute(input, checkpoint); } finally { running.delete(taskId); }
  }

  // Persists the Supervisor outcome for a coding request and preserves failures for Resume.
  async function execute(input, checkpoint) {
    const { task_id: taskId, project_id: projectId, text } = input;
    const requestId = `REQ-${taskId}-${clock().getTime()}`;
    const correlationId = `CORR-${taskId}`;
    const inputPath = `.forge/runtime/nf/code-requests/${taskId}.json`;
    const resultPath = `.forge/runtime/nf/code-requests/${taskId}.result.json`;
    projectLogger({ timestamp: clock().toISOString(), event_name: checkpoint ? "direct_code.resumed" : "direct_code.started", level: "info", status: "started", message: checkpoint ? "Direct code request resumed from checkpoint." : "Direct code request saved and sent to Supervisor.", task_id: taskId, correlation_id: correlationId, source: "direct-code-request", payload: { input_path: inputPath, resumed_from_turn: checkpoint?.last_completed_turn ?? 0 } });
    const ticket = { id: taskId, project_id: projectId, title: text.trim().split("\n")[0].slice(0, 160), objective: text, acceptance_criteria: [], required_role: "coder" };
    let result;
    try {
      result = await integration.submitTicket({ ticket, task_id: taskId, project_id: projectId, request_id: requestId, correlation_id: correlationId, required_role: "coder", payload: { text, direct_code: true, task: ticket, ticket, ...(checkpoint ? { resume_from: checkpoint } : {}) } });
    } catch (error) {
      try {
        await fileService.atomicWrite({ path: resultPath, content: `${JSON.stringify({ task_id: taskId, status: "failed", error_code: error.code ?? "DIRECT_CODE_FAILED", error: error.message, completed_at: clock().toISOString() }, null, 2)}\n`, replace: true });
      } catch (storageError) {
        projectLogger({ timestamp: clock().toISOString(), event_name: "direct_code.result_write_failed", level: "error", status: "failed", message: "Could not save the failed coder result.", task_id: taskId, correlation_id: correlationId, source: "direct-code-request", error_code: storageError.code ?? "DIRECT_CODE_RESULT_WRITE_FAILED", payload: { result_path: resultPath, dispatch_error_code: error.code ?? "DIRECT_CODE_FAILED" } });
      }
      projectLogger({ timestamp: clock().toISOString(), event_name: "direct_code.failed", level: "error", status: "failed", message: "Supervisor failed a direct coder request.", task_id: taskId, correlation_id: correlationId, source: "direct-code-request", error_code: error.code ?? "DIRECT_CODE_FAILED", payload: { result_path: resultPath } });
      throw error;
    }
    const outcome = { task_id: taskId, status: result.status, agent_id: result.agent_id, response: result.response, completed_at: clock().toISOString() };
    try {
      await fileService.atomicWrite({ path: resultPath, content: `${JSON.stringify(outcome, null, 2)}\n`, replace: true });
    } catch (error) {
      projectLogger({ timestamp: clock().toISOString(), event_name: "direct_code.result_write_failed", level: "error", status: "failed", message: "Coder completed but the result could not be saved.", task_id: taskId, correlation_id: correlationId, source: "direct-code-request", error_code: error.code ?? "DIRECT_CODE_RESULT_WRITE_FAILED", payload: { result_path: resultPath } });
      throw error;
    }
    projectLogger({ timestamp: clock().toISOString(), event_name: "direct_code.completed", level: "info", status: "success", message: "Supervisor completed direct coder request.", task_id: taskId, correlation_id: correlationId, source: "direct-code-request", payload: { result_path: resultPath, agent_id: result.agent_id } });
    return { ...outcome, input_path: inputPath, result_path: resultPath };
  }
}

// Rejects invalid dashboard requests before creating an input file or agent task.
function invalid(message) { return Object.assign(new ConfigurationError(message), { code: "DIRECT_CODE_INPUT_INVALID", statusCode: 400 }); }
