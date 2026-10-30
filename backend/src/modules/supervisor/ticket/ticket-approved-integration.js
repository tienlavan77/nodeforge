// Integrates reviewed ticket commits before releasing their file and agent claims.

// Finishes an approved review only after the root branch records the reviewed ticket change.
export async function completeApprovedTicket({ workspace, reviewerClaim, agentOccupancy, coderClaim, taskId, ownerId, request, projectLogger, publishTicketOutcome, selected, result }) {
  try { if (workspace) {
    await workspace.testService.assertPassedArtifact();
    const before = await workspace.executionContexts.load(taskId);
    if (before.state !== "terminal" && before.state !== "integrating") await workspace.executionContexts.update(taskId, before.version, { state: "integrating" });
    await workspace.integrate();
    const after = await workspace.executionContexts.load(taskId);
    if (after.state !== "terminal") await workspace.executionContexts.update(taskId, after.version, { state: "terminal" });
  } }
  catch (error) {
    projectLogger({ event_name: "ticket.integration_failed", level: "error", status: "failed", message: "Approved ticket could not be integrated.", task_id: taskId, source: "nodeforge-task-integration", error_code: error.code ?? "TICKET_INTEGRATION_FAILED", payload: { error: error.message } });
    if (reviewerClaim) await agentOccupancy.release({ claimId: reviewerClaim.claim_id, taskId, supervisorId: ownerId, reason: "integration_failed" });
    await publishTicketOutcome("task.needs_human_review", request, ownerId, { reason: error.code ?? "TICKET_INTEGRATION_FAILED" });
    return { task_id: taskId, request_id: request.request_id, agent_id: selected.agent_id, status: "needs_human_review", reason: error.code ?? "TICKET_INTEGRATION_FAILED", response: result.summary, tool_events: result.tool_events };
  }
  if (workspace) await workspace.changeLedger.release();
  await workspace?.reportService?.completeAcceptedReport?.(taskId);
  if (reviewerClaim) await agentOccupancy.release({ claimId: reviewerClaim.claim_id, taskId, supervisorId: ownerId, reason: "review_completed" });
  await agentOccupancy.release({ claimId: coderClaim.claim_id, taskId, supervisorId: ownerId, reason: "accepted" });
  return null;
}
