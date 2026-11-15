// Coordinates owner-approved pauses and recovery of role-scoped owner conversation executions.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { ownerExecutionRolePolicy } from "./owner-execution-role-policy.js";

// Provides scoped execution controls without replaying uncertain Git or file operations.
export function createOwnerExecutionControl({ checkpoint, architectureCheckpoint, sdkStream, ownerChatService, communications, agentConfiguration, projectLogger = console.error }) {
  const checkpointStores = { system_engineer: checkpoint, architecture_manager: architectureCheckpoint };
  // Resolves only the checkpoint store allowed for the conversation's configured role.
  function storeFor(agentId) {
    const role = agentConfiguration?.getById?.(agentId)?.role;
    const store = Object.hasOwn(checkpointStores, role) ? checkpointStores[role] : null;
    if (store && store.role === role) return store;
    throw Object.assign(new ConfigurationError("Execution not found for this conversation."), { statusCode: 404 });
  }

  // Ensures an execution belongs to the selected role-scoped conversation.
  async function locate(conversationId, executionId, agentId) {
    const store = storeFor(agentId);
    const record = await store.load(conversationId, executionId);
    if (!record || !record.message_id) throw Object.assign(new ConfigurationError("Execution not found."), { statusCode: 404 });
    const message = communications?.getById?.(record.message_id);
    if (!message || message.conversation_id !== conversationId || message.recipient?.id !== agentId || record.role !== agentConfiguration.getById(agentId).role) throw Object.assign(new ConfigurationError("Execution not found for this conversation."), { statusCode: 404 });
    return { record, message, store };
  }

  // Exposes only recovery actions and identity, never private checkpoint receipts or provider sessions.
  async function summary(record, store) {
    const recoverable = record.status === "interrupted" && await store.reconcile(record);
    const safelyDiscardable = ["interrupted", "manual_required"].includes(record.status) && Boolean(record.runner_stopped_at) && !record.active_mutations;
    return { conversation_id: record.conversation_id, execution_id: record.execution_id, role: record.role, display_name: ownerExecutionRolePolicy(record.role).displayName, status: record.status, tool_mode: record.tool_mode ?? "forge", checkpoint_kind: record.checkpoint_kind ?? "forge_receipts",
      can_continue: Boolean(recoverable && record.provider_thread_id), can_restart: Boolean(recoverable), can_discard: Boolean(safelyDiscardable),
      can_reconcile: ownerExecutionRolePolicy(record.role).architectureMutations && record.status === "manual_required" && Boolean(record.runner_stopped_at) && !record.active_mutations && !record.receipts_truncated && record.pending_tool_calls?.length === 1,
      requires_human_review: record.status === "manual_required" };
  }

  // Returns only recoverable attempts whose source message belongs to this role-scoped conversation.
  async function list(conversationId, agentId) {
    const store = storeFor(agentId);
    const records = await store.inspect(conversationId);
    const authorized = [];
    for (const record of records) {
      try { if (!["completed", "discarded", "restarted"].includes(record.status)) { const found = await locate(conversationId, record.execution_id, agentId); const stopped = record.status === "interrupted" && !record.runner_stopped_at && !sdkStream?.isActive?.(conversationId) ? await store.markRecoveredStopped?.(conversationId, record.execution_id) : null; authorized.push(await summary(stopped ?? record, found.store)); } }
      catch (error) { if (error.statusCode !== 404) throw error; }
    }
    return authorized;
  }

  // Requests an active SDK abort and lets its runner finish the interrupted checkpoint.
  async function pause(conversationId, executionId, agentId) {
    const { record, store } = await locate(conversationId, executionId, agentId);
    if (record.status !== "running" || !sdkStream.pause(conversationId)) throw Object.assign(new ConfigurationError("Execution is no longer running."), { statusCode: 409 });
    return summary({ ...record, status: "pausing" }, store);
  }

  // Applies an explicit Continue, Restart, or Discard decision to an interrupted attempt.
  async function decide(conversationId, executionId, agentId, decision) {
    const { record, message, store } = await locate(conversationId, executionId, agentId);
    await store.inspect(conversationId);
    const fresh = await store.load(conversationId, executionId);
    if (decision === "discard") return summary(await store.close(conversationId, executionId, "discarded"), store);
    if (fresh.status !== "interrupted") throw Object.assign(new ConfigurationError("Execution is not interrupted."), { statusCode: 409 });
    if (!["continue", "restart"].includes(decision)) throw Object.assign(new ConfigurationError("Invalid execution decision."), { statusCode: 400 });
    if (decision === "continue" && !fresh.provider_thread_id) throw Object.assign(new ConfigurationError("Provider session is unavailable; choose Restart instead of Continue."), { code: "EXECUTION_SESSION_UNAVAILABLE", statusCode: 409 });
    if (!await store.reconcile(fresh)) throw Object.assign(new ConfigurationError("Workspace or Git state needs manual reconciliation before retry."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
    const nextId = decision === "continue" ? executionId : randomUUID();
    const replay = { ...message, id: `RESUME-${randomUUID()}`, correlation_id: nextId, payload: { ...message.payload, source_message_id: message.id, ...(decision === "continue" ? { continue_execution: true } : { resume_of: executionId }) } };
    void ownerChatService.replay(replay, agentId);
    return summary({ ...record, execution_id: nextId, status: "running" }, store);
  }

  // Business purpose: resumes safe owner executions after an API process restart so a transient SIGBUS does not permanently strand an agent turn.
  // Technical description: scans persisted owner messages and role checkpoints, then reuses the existing Continue path only for interrupted executions whose provider session and workspace reconciliation are valid.
  async function recoverInterrupted() {
    const profiles = typeof agentConfiguration?.getAll === "function" ? agentConfiguration.getAll() : [];
    const messages = typeof communications?.getAll === "function" ? communications.getAll() : [];
    const candidates = new Map();
    for (const message of messages) {
      if (message?.message_type !== "owner.message" || !message.conversation_id || !message.recipient?.id) continue;
      candidates.set(`${message.conversation_id}:${message.recipient.id}`, { conversationId: message.conversation_id, agentId: message.recipient.id });
    }
    for (const candidate of candidates.values()) {
      const profile = profiles.find((entry) => entry?.agent_id === candidate.agentId || entry?.id === candidate.agentId);
      if (!profile || !["system_engineer", "architecture_manager"].includes(profile.role)) continue;
      try {
        const resumable = (await list(candidate.conversationId, candidate.agentId)).filter((entry) => entry.can_continue);
        for (const execution of resumable) {
          await decide(candidate.conversationId, execution.execution_id, candidate.agentId, "continue");
          projectLogger?.({ event_name: "owner.execution_auto_resumed", level: "info", status: "success", message: "Resumed a safe owner execution after API restart.", conversation_id: candidate.conversationId, task_id: execution.execution_id, payload: { agent_id: candidate.agentId, role: profile.role } });
        }
      } catch (error) {
        projectLogger?.({ event_name: "owner.execution_auto_resume_failed", level: "error", status: "failed", message: error.message, conversation_id: candidate.conversationId, payload: { agent_id: candidate.agentId, error_code: error.code ?? "OWNER_AUTO_RESUME_FAILED" } });
      }
    }
  }

  // Reconciles one uncertain Architecture document only after server-verified runner stop and file state.
  async function reconcilePending(conversationId, executionId, agentId, sequence, actorId) {
    const { store } = await locate(conversationId, executionId, agentId);
    if (!requiresOwnerAuth(agentId)) throw Object.assign(new ConfigurationError("Architecture reconciliation is not available for this role."), { statusCode: 404 });
    await store.inspect(conversationId);
    const fresh = await store.load(conversationId, executionId);
    const pending = fresh?.pending_tool_calls ?? [];
    if (pending.length !== 1 || (sequence !== undefined && sequence !== pending[0].sequence)) throw Object.assign(new ConfigurationError("Document state requires manual reconciliation."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
    return summary(await store.reconcilePending(conversationId, executionId, pending[0].sequence, actorId));
  }

  // Requires verified project-owner identity before exposing Architecture execution records.
  function requiresOwnerAuth(agentId) {
    const role = agentConfiguration?.getById?.(agentId)?.role;
    return Object.hasOwn(checkpointStores, role) && ownerExecutionRolePolicy(role).requiresOwnerAuth;
  }

  return Object.freeze({ list, pause, decide, recoverInterrupted, reconcilePending, requiresOwnerAuth });
}
