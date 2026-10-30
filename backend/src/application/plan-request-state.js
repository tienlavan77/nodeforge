// Persists Architecture planning request progress so Coding can recover generating/error state after missed delivery.
import { statePath } from "../infrastructure/filesystem/forge-paths.js";
import { randomUUID } from "node:crypto";
import { acquireTicketFileLock } from "../modules/supervisor/ticket/ticket-file-lock.js";

const PROCESS_ID = randomUUID();

// Treats another live local process as active; never retries a provider request from this probe.
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

// Stores bounded project-scoped request snapshots without credentials or generated plan content.
export function createPlanRequestState({ projectId, fileService }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId ?? "") || !fileService?.createLock || !fileService?.readFile || !fileService?.atomicWrite) throw new TypeError("Plan request state requires a safe project ID and Node File Service.");
  const path = `${statePath()}/nf/plan-requests/${projectId}.json`;
  return { start, complete, wait, fail, list };

  // Records an intentional owner clarification pause without claiming that a plan has been persisted.
  async function wait(request, result) { await save({ ...request, status: "awaiting_owner_decisions", session_id: result.session_id }); }

  // Records intent before contacting Architecture, without treating it as a reviewable artifact.
  async function start() {
    const request = { request_id: `PLAN-REQUEST-${randomUUID()}`, project_id: projectId, process_id: PROCESS_ID, process_pid: process.pid, status: "generating", created_at: new Date().toISOString() };
    await save(request);
    return request;
  }

  // Publishes the exact persisted artifact identity only after the plan command has succeeded.
  async function complete(request, plan) {
    for (const pending of (await read()).filter((item) => item.status === "awaiting_owner_decisions" && item.session_id === plan.session_id)) await save({ ...pending, status: "persisted", plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256 });
    await save({ ...request, status: "persisted", plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256 });
  }

  // Retains a safe error code so reconnecting Coding clients can distinguish failure from no plan.
  async function fail(request, error) { await save({ ...request, status: "failed", error_code: String(error.code ?? "PLAN_REQUEST_FAILED").replace(/[^A-Z0-9_]/g, "").slice(0, 80) || "PLAN_REQUEST_FAILED" }); }

  // Repairs the presentation of requests abandoned by an earlier server process without relaunching them.
  async function list() {
    const records = await read();
    return records.map(({ process_id: processId, process_pid: pid, ...request }) => ({ ...request, ...(request.status === "generating" && processId !== PROCESS_ID && !processAlive(pid) ? { status: "interrupted", error_code: "PLAN_REQUEST_INTERRUPTED" } : {}) }));
  }

  // Reads only this project's Node-owned request snapshot.
  async function read() {
    try { return JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  // Serializes status writes and keeps recent request diagnostics separate from immutable plan history.
  async function save(request) {
    const lock = await acquireTicketFileLock(fileService, `${path}.lock`);
    try {
      const records = await read();
      const current = [...records.filter((item) => item.request_id !== request.request_id), { ...request, updated_at: new Date().toISOString() }];
      const next = [...current.filter((item) => item.status === "generating"), ...current.filter((item) => item.status !== "generating").slice(-50)];
      await fileService.atomicWrite({ path, content: JSON.stringify(next), replace: true });
    } finally { await lock.release(); }
  }
}
