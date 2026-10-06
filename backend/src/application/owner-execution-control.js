// Coordinates owner-approved pauses and recovery of direct System Engineer conversation executions.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Provides scoped execution controls without replaying uncertain Git or file operations.
export function createOwnerExecutionControl({ checkpoint, sdkStream, ownerChatService, communications, agentConfiguration }) {
  // Ensures an execution belongs to the selected System Engineer conversation.
  async function locate(conversationId, executionId, agentId) {
    const record = await checkpoint.load(conversationId, executionId);
    if (!record || !record.message_id) throw Object.assign(new ConfigurationError("Execution not found."), { statusCode: 404 });
    const message = communications?.getById?.(record.message_id);
    if (!message || message.conversation_id !== conversationId || message.recipient?.id !== agentId || agentConfiguration?.getById?.(agentId)?.role !== "system_engineer") throw Object.assign(new ConfigurationError("Execution not found for this conversation."), { statusCode: 404 });
    return { record, message };
  }

  // Returns durable checkpoints so the UI can show interruptions after a reload.
  async function list(conversationId) {
    return checkpoint.inspect(conversationId);
  }

  // Requests an active SDK abort and lets its runner finish the interrupted checkpoint.
  async function pause(conversationId, executionId, agentId) {
    const { record } = await locate(conversationId, executionId, agentId);
    if (record.status !== "running" || !sdkStream.pause(conversationId)) throw Object.assign(new ConfigurationError("Execution is no longer running."), { statusCode: 409 });
    return { ...record, status: "pausing" };
  }

  // Applies an explicit Continue, Restart, or Discard decision to an interrupted attempt.
  async function decide(conversationId, executionId, agentId, decision) {
    const { record, message } = await locate(conversationId, executionId, agentId);
    await checkpoint.inspect(conversationId);
    const fresh = await checkpoint.load(conversationId, executionId);
    if (fresh.status !== "interrupted") throw Object.assign(new ConfigurationError("Execution is not interrupted."), { statusCode: 409 });
    if (decision === "discard") return checkpoint.close(conversationId, executionId, "discarded");
    if (!["continue", "restart"].includes(decision)) throw Object.assign(new ConfigurationError("Invalid execution decision."), { statusCode: 400 });
    if (!await checkpoint.reconcile(fresh)) throw Object.assign(new ConfigurationError("Workspace or Git state needs manual reconciliation before retry."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
    const nextId = decision === "continue" ? executionId : randomUUID();
    const replay = { ...message, id: `RESUME-${randomUUID()}`, correlation_id: nextId, payload: { ...message.payload, source_message_id: message.id, ...(decision === "continue" ? { continue_execution: true } : { resume_of: executionId }) } };
    void ownerChatService.replay(replay, agentId);
    return { ...record, execution_id: nextId, status: "running", ...(decision === "restart" ? { resume_of: executionId } : {}) };
  }

  return Object.freeze({ list, pause, decide });
}
