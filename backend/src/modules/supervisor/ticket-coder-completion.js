// Completes a ticket from verified Coder evidence without dispatching an inline Reviewer.
import { ConfigurationError } from "../../shared/errors.js";

// Records the verified commit and releases ticket claims after a complete Coder report.
export async function completeCoderTicket({ workspace, agentOccupancy, claim, taskId, ownerId, request, publishTicketOutcome, result }) {
  const resumedFromCompletedCoder = Boolean(request?.payload?.review_resume && workspace);
  if (!resumedFromCompletedCoder && !result.tool_events?.some((event) => (event.name ?? event.tool) === "report_done" && event.status !== "failed")) {
    throw Object.assign(new ConfigurationError("Coder completion requires report_done for the verified ticket artifact."), { code: "AGENT_REPORT_MISSING" });
  }
  let artifact = null;
  try {
    artifact = workspace ? await finalizeCoderWorkspace(workspace, taskId) : null;
  } catch (error) {
    await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "coder_completion_failed" });
    await publishTicketOutcome("task.failed", request, ownerId, { reason: error.code ?? "CODER_COMPLETION_FAILED", error: { code: error.code ?? "CODER_COMPLETION_FAILED", message: error.message } });
    throw error;
  }
  await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "coder_completed" });
  await publishTicketOutcome("task.completed", request, ownerId, { summary: result.summary, artifact_id: artifact?.artifact_id ?? null, commit_sha: artifact?.commit_sha ?? null, completion: "coder_verified" });
}

// Completes a verified workspace only after its Coder report covers every criterion.
export async function finalizeCoderWorkspace(workspace, taskId) {
  const artifact = await workspace.testService.assertPassedArtifact();
  await workspace.reportService.assertCoderReport(taskId);
  const before = await workspace.executionContexts.load(taskId);
  if (before.state !== "terminal" && before.state !== "integrating") await workspace.executionContexts.update(taskId, before.version, { state: "integrating" });
  await workspace.integrate();
  await workspace.reportService.completeCoderReport(taskId);
  const after = await workspace.executionContexts.load(taskId);
  if (after.state !== "terminal") await workspace.executionContexts.update(taskId, after.version, { state: "terminal" });
  await workspace.changeLedger.release();
  return artifact;
}
