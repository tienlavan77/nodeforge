// Classifies Coder execution failures as resumable failures instead of forcing a human-review terminal state.

// Records a failed Coder attempt, releases its agent claim, and emits the appropriate terminal event.
export async function handleTicketExecutionFailure({ error, failedRequest, selected, claim, taskId, ownerId, checkpoints, agentOccupancy, projectLogger, publishTicketOutcome }) {
  projectLogger({ event_name: "supervisor.tool_ticket_failed", level: "error", status: "failed", message: "Ticket execution failed.", task_id: failedRequest.task_id, correlation_id: failedRequest.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "TOOL_TICKET_FAILED", payload: { request_id: failedRequest.request_id, agent_id: selected?.agent_id, agent_name: selected?.agent_name, ...(error.tool ? { tool: error.tool } : {}), error: error.message } });
  if (!claim) return;
  const checkpoint = await checkpoints?.load?.(taskId);
  if (error.code === "COMMIT_APPROVAL_REJECTED") {
    await checkpoints?.save?.({ ...(checkpoint ?? { task_id: taskId }), status: "failed", phase: "commit_approval", failure: { code: error.code, message: error.message, at: new Date().toISOString() } });
    await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "commit_approval_rejected" });
    await publishTicketOutcome("task.failed", failedRequest, ownerId, { reason: error.code, retryable: true });
    return;
  }
  if (checkpoint?.status === "blocked") {
    const failureCode = checkpoint.failure?.code ?? error.code ?? "CONFIGURATION_ERROR";
    const message = checkpoint.failure?.message ?? error.message;
    await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: failureCode === "AGENT_PROCESS_EXITED" ? "agent_process_exited" : "agent_failed_terminal" });
    if (isRetryableSdkFailure(failureCode, message)) {
      await checkpoints.save({ ...checkpoint, status: "failed" });
      await publishTicketOutcome("task.failed", failedRequest, ownerId, { reason: failureCode, error: { code: failureCode, message } });
      return;
    }
    await checkpoints.save({ ...checkpoint, status: "failed", failure: { ...(checkpoint.failure ?? {}), code: failureCode, message, at: new Date().toISOString() } });
    await publishTicketOutcome("task.failed", failedRequest, ownerId, { reason: failureCode, retryable: true, error: { code: failureCode, message } });
    return;
  }
  if (!checkpoint || checkpoint.status === "completed") {
    await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "agent_failed_terminal" });
    if (failedRequest.payload?.direct_code !== true && !failedRequest.payload?.tool_test) await publishTicketOutcome("task.failed", failedRequest, ownerId, { error: { code: error.code ?? "TOOL_TICKET_FAILED", message: error.message } });
  } else projectLogger({ event_name: "agent.occupancy_retained", level: "info", status: "info", message: "Coder claim retained for a resumable checkpoint.", task_id: taskId, source: "nodeforge-task-integration", payload: { claim_id: claim.claim_id, checkpoint_status: checkpoint.status } });
}

// Separates SDK transport and process failures from review decisions while retaining the Coder checkpoint.
function isRetryableSdkFailure(code, message) {
  return code === "AGENT_PROCESS_EXITED" || code === "SERVICE_UNAVAILABLE"
    || code === "CONFIGURATION_ERROR" && /^(?:Codex|Claude) SDK (?:request|turn) (?:failed|timed out)/.test(message ?? "");
}
