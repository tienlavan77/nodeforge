// Saves a direct coding request so Supervisor can dispatch the owner's exact text without creating a sprint ticket.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Creates a File Service backed entry point for coding directly from the sprint dashboard.
export function createDirectCodeRequest({ fileService, integration, projectId: expectedProjectId, projectLogger = () => {}, clock = () => new Date() } = {}) {
  if (typeof fileService?.atomicCreate !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Direct code requests require File Service storage.");
  if (typeof integration?.submitTicket !== "function") throw new ConfigurationError("Direct code requests require Supervisor dispatch.");
  return Object.freeze({ run });

  // Persists the input and outcome while Supervisor selects and runs an available coder.
  async function run({ projectId, sprintId, text } = {}) {
    if (typeof projectId !== "string" || !projectId.trim()) throw invalid("project_id is required.");
    if (expectedProjectId && projectId !== expectedProjectId) throw invalid("project_id does not match the active project.");
    if (typeof text !== "string" || !text.trim() || text.length > 50000) throw invalid("Code request must contain 1–50000 characters.");
    if (sprintId !== undefined && (typeof sprintId !== "string" || !sprintId.trim())) throw invalid("sprint_id is invalid.");
    const taskId = `CODE-${clock().getTime()}-${randomUUID()}`;
    const requestId = `REQ-${taskId}`;
    const correlationId = `CORR-${taskId}`;
    const inputPath = `.forge/runtime/nf/code-requests/${taskId}.json`;
    const resultPath = `.forge/runtime/nf/code-requests/${taskId}.result.json`;
    const input = { task_id: taskId, project_id: projectId, required_role: "coder", mode: "direct_code", ...(sprintId ? { sprint_id: sprintId } : {}), text, created_at: clock().toISOString() };
    await fileService.atomicCreate({ path: inputPath, content: `${JSON.stringify(input, null, 2)}\n` });
    projectLogger({ timestamp: clock().toISOString(), event_name: "direct_code.started", level: "info", status: "started", message: "Direct code request saved and sent to Supervisor.", task_id: taskId, correlation_id: correlationId, source: "direct-code-request", payload: { input_path: inputPath } });
    const ticket = { id: taskId, project_id: projectId, title: text.trim().split("\n")[0].slice(0, 160), objective: text, acceptance_criteria: [], required_role: "coder" };
    let result;
    try {
      result = await integration.submitTicket({ ticket, task_id: taskId, project_id: projectId, request_id: requestId, correlation_id: correlationId, required_role: "coder", payload: { text, direct_code: true, task: ticket, ticket } });
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
