import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

/** Initializes a stage-1 task without coupling orchestration to storage details. */
export function createStage1TaskInitializer({ statusStore, gitService, protocolLogger, createRequestId = randomUUID } = {}) {
  if (!statusStore || typeof statusStore.get !== "function" || typeof statusStore.create !== "function" || typeof statusStore.updateStatus !== "function" || typeof statusStore.dependenciesReady !== "function") throw new ConfigurationError("Stage-1 initializer requires a Ticket Status Store.");
  if (!gitService || typeof gitService.createBranch !== "function" || typeof gitService.branchExists !== "function") throw new ConfigurationError("Stage-1 initializer requires a Git Service.");
  if (!protocolLogger || typeof protocolLogger.requestSent !== "function" || typeof protocolLogger.failed !== "function") throw new ConfigurationError("Stage-1 initializer requires a Protocol Step Logger.");
  if (typeof createRequestId !== "function") throw new ConfigurationError("Stage-1 initializer createRequestId must be a function.");

  return Object.freeze({ initTask });

  async function initTask(ticket) {
    assertTicket(ticket);
    const requestId = createRequestId();
    const baseContext = { task_id: ticket.id, step_id: 1, type: "task", role: "node", request_id: requestId, parent_id: null };
    let status = ensurePending(ticket.id);
    if (ticket.status === "failed" && status.status === "done" && typeof statusStore.resetDoneForRetry === "function") status = statusStore.resetDoneForRetry(ticket.id, { reason: "roadmap_failed_retry" });
    if (["failed", "needs_human_review"].includes(status.status)) status = statusStore.retry(ticket.id, { reason: "user_dispatch" });
    const dependencies = statusStore.dependenciesReady(ticket.id, ticket.dependencies ?? []);
    if (!dependencies.ready) {
      if (status.status === "pending") status = statusStore.updateStatus(ticket.id, "blocked", { reason: "dependencies", blocked_by: dependencies.blocked_by }, { expectedCurrentStatus: "pending" });
      protocolLogger.failed({ ...baseContext, status: "blocked" });
      return Object.freeze({ status, blocked_by: dependencies.blocked_by, branch: null, request_id: requestId });
    }
    if (status.status === "blocked") {
      status = statusStore.updateStatus(ticket.id, "pending", { reason: "dependencies_ready" }, { expectedCurrentStatus: "blocked" });
    }
    if (status.status === "pending") {
      const branchName = `task/${ticket.id}`;
      if (!(await gitService.branchExists(branchName))) await gitService.createBranch(branchName);
      status = statusStore.updateStatus(ticket.id, "running", { reason: "task_initialized", branch: branchName }, { expectedCurrentStatus: "pending" });
    }
    protocolLogger.requestSent(baseContext);
    return Object.freeze({ status, blocked_by: [], branch: `task/${ticket.id}`, request_id: requestId });
  }

  function ensurePending(ticketId) {
    const current = statusStore.get(ticketId);
    if (current) return current;
    try { return statusStore.create(ticketId, { reason: "task_initialized" }); }
    catch (error) {
      if (error.code === "STATUS_EXISTS") return statusStore.get(ticketId);
      throw error;
    }
  }
}

function assertTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string" || !ticket.id || typeof ticket.project_id !== "string" || !ticket.project_id) throw new ConfigurationError("Stage-1 initializer requires ticket id and project_id.");
  if (ticket.dependencies !== undefined && !Array.isArray(ticket.dependencies)) throw new ConfigurationError("Ticket dependencies must be an array.");
}
