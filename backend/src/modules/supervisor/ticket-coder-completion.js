// Completes verified Coder work through blocking review or asynchronous post-completion review according to ticket policy.
import { ConfigurationError } from "../../shared/errors.js";
import { releaseTicketAttempt } from "./ticket-attempt-release.js";
import { automaticReviewPolicy, bindAutomaticReviewCycle } from "./automatic-review-identity.js";
import { inspectReviewRepairProgress } from "./review-repair-progress.js";

// Records the verified commit and releases ticket claims after a complete Coder report.
export async function completeCoderTicket({ workspace, agentOccupancy, claim, taskId, ownerId, request, publishTicketOutcome, result, automaticReview, runRepair, checkpoints, projectLogger = () => {} }) {
  request = bindAutomaticReviewCycle(request, await workspace?.executionContexts?.load?.(taskId));
  const resumedFromCompletedCoder = Boolean(request?.payload?.review_resume && workspace);
  const submittedResponse = workspace && result.tool_events?.some((event) => (event.name ?? event.tool) === "respond_to_review" && event.status !== "failed");
  if (!resumedFromCompletedCoder && !submittedResponse && !result.tool_events?.some((event) => (event.name ?? event.tool) === "report_done" && event.status !== "failed")) {
    throw Object.assign(new ConfigurationError("Coder completion requires report_done for the verified ticket artifact."), { code: "AGENT_REPORT_MISSING" });
  }
  let artifact = null;
  let reviewJob = null;
  let reviewed = false;
  let previousReviewKey = null;
  let preparationFailure = null;
  const policy = automaticReviewPolicy(request?.ticket, { blocking: Boolean(request?.payload?.review_cycle_id) });
  if (policy.gate === "on" && (!automaticReview || !workspace)) {
    await publishTicketOutcome("task.needs_human_review", request, ownerId, { reason: "REVIEW_WORKER_UNAVAILABLE", outcome_label: "review_unavailable" });
    await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "review_unavailable" });
    return { status: "needs_human_review", reason: "REVIEW_WORKER_UNAVAILABLE" };
  }
  try {
    if (automaticReview && workspace) {
      while (!reviewed) {
        artifact = await workspace.testService.assertPassedArtifact();
        await workspace.reportService.assertCoderReport(taskId, request.ticket);
        try { reviewJob = await automaticReview.prepare({ request: { ...request, supervisor_id: ownerId }, artifact, workspace }); }
        catch (error) {
          projectLogger({ event_name: "review.prepare_failed", level: "error", status: "failed", message: error.message, task_id: taskId, source: "ticket-coder-completion", error_code: error.code });
          const payload = { automatic_review: true, inline_review: true, review_gate: policy.gate, outcome_label: "review_failed", error: { code: error.code ?? "REVIEW_FAILED", message: error.message }, artifact_id: artifact.artifact_id, source_revision: artifact.source_revision };
          if (payload.review_gate === "on") { await publishTicketOutcome("review.failed", request, ownerId, payload); await publishTicketOutcome("task.needs_human_review", request, ownerId, { reason: payload.error.code }); await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "review_prepare_failed" }); return { status: "needs_human_review", reason: payload.error.code }; }
          preparationFailure = payload;
          break;
        }
        if (reviewJob.job_key === previousReviewKey) throw Object.assign(new ConfigurationError("Repair must submit a new verified revision or durable Coder response."), { code: "REVIEW_REPAIR_REVISION_REQUIRED" });
        if (reviewJob.review_policy.gate === "off") break;
        const outcome = await automaticReview.process(reviewJob);
        if (outcome.payload.verdict === "approved") { await automaticReview.assertApproval({ ...outcome.payload, job_key: reviewJob.job_key, decision_identity: reviewJob.decision_identity }); reviewed = true; break; }
        if (outcome.payload.owner_decision_reason || outcome.payload.verdict !== "request_changes" || !runRepair || !(await automaticReview.consumeRepair(reviewJob))) {
          const reason = outcome.payload.owner_decision_reason ?? (outcome.payload.verdict === "request_changes" ? "review_repair_unavailable" : outcome.payload.error?.code ?? "review_failed");
          const parked = await automaticReview.park(reviewJob, reason);
          await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason });
          return { status: parked?.status ?? "needs_human_review", reason };
        }
        const findings = await workspace.reviewFindings.unresolved();
        previousReviewKey = reviewJob.job_key;
        let unchangedRepair = null;
        let progress;
        do {
          ({ request, result } = await runRepair({ request, findings, outcome: { ...outcome,
            payload: { ...outcome.payload, ...(progress ? { repair_implementation_required: progress } : {}) } } }));
          progress = await inspectReviewRepairProgress({ workspace, artifact, findings, result });
          if (progress?.signature === unchangedRepair) {
            const reason = "REVIEW_REPAIR_NO_PROGRESS";
            const retained = await checkpoints?.load?.(taskId);
            if (retained) await checkpoints.save({ ...retained, status: "failed", phase: "finding_repair_ready",
              repair_implementation_required: progress, failure: { code: reason, message: progress.instruction } });
            await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason });
            await publishTicketOutcome("task.failed", request, ownerId, { reason, retryable: true,
              error: { code: reason, message: "Accepted findings remain unchanged after an explicit implementation handoff. Resume Coder from its checkpoint; another Reviewer pass cannot repair the source." } });
            return { status: "failed", reason };
          }
          if (progress) {
            unchangedRepair = progress.signature;
            projectLogger({ event_name: "review.implementation_required", level: "info", status: "pending", task_id: taskId,
              message: "Coder accepted unresolved findings without changing their verified source; continue implementation before another review.", payload: { finding_ids: progress.finding_ids, commit_sha: artifact.commit_sha } });
          }
        } while (progress);
      }
    }
    if (reviewJob) await automaticReview.recordCompletion(reviewJob, { summary: result.summary, artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, completion: reviewed ? "reviewed" : "coder_verified" });
    artifact = workspace ? await finalizeCoderWorkspace(workspace, taskId, { reviewed, ticket: request.ticket }) : null;
  } catch (error) {
    // Route finding-repair blockers to the shared execution handler before review parking can swallow their triage.
    if (error.code === "CODER_BLOCKED") throw error;
    if (error.code === "TICKET_STOPPED") { await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: error.code }); return { status: "failed", reason: error.code }; }
    if (automaticReview && reviewJob?.review_policy.gate === "on") {
      projectLogger({ event_name: "review.completion_failed", level: "error", status: "blocked", message: error.message, task_id: taskId, source: "ticket-coder-completion", error_code: error.code });
      const parked = await automaticReview.park(reviewJob, error.code ?? "REVIEW_FAILED");
      if (error.code !== "PROVIDER_UNKNOWN" && !error.launch_claim_conflict) await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "review_completion_failed" });
      return { status: parked?.status ?? "needs_human_review", reason: error.code ?? "REVIEW_FAILED" };
    }
    await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "coder_completion_failed" });
    if (error.code === "CODER_EVIDENCE_PENDING") {
      await publishTicketOutcome("task.failed", request, ownerId, { reason: error.code, retryable: true, criterion_ids: error.details?.criterion_ids ?? [], error: { code: error.code, message: error.message } });
      return { status: "failed", reason: error.code };
    }
    await publishTicketOutcome("task.failed", request, ownerId, { reason: error.code ?? "CODER_COMPLETION_FAILED", error: { code: error.code ?? "CODER_COMPLETION_FAILED", message: error.message } });
    throw error;
  }
  const payload = { summary: result.summary, artifact_id: artifact?.artifact_id ?? null, commit_sha: artifact?.commit_sha ?? null, completion: reviewed ? "reviewed" : "coder_verified" };
  await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "coder_completed" });
  if (reviewJob) await automaticReview.publishCompletion(reviewJob);
  else await publishTicketOutcome("task.completed", request, ownerId, payload);
  if (preparationFailure) await publishTicketOutcome("review.failed", request, ownerId, preparationFailure);
  if (reviewJob?.review_policy.gate === "off") {
    try { await automaticReview.dispatch(reviewJob); }
    catch (error) { projectLogger({ event_name: "review.dispatch_deferred", level: "error", status: "pending", message: error.message, task_id: taskId, source: "ticket-coder-completion", error_code: error.code }); }
  }
  return { status: "completed" };
}

// Completes a verified workspace only after its Coder report covers every criterion.
export async function finalizeCoderWorkspace(workspace, taskId, { reviewed = false, ticket } = {}) {
  const artifact = await workspace.testService.assertPassedArtifact();
  await workspace.reportService.assertCoderReport(taskId, ticket);
  const before = await workspace.executionContexts.load(taskId);
  if (before.state !== "terminal" && before.state !== "integrating") await workspace.executionContexts.update(taskId, before.version, { state: "integrating" });
  await workspace.integrate();
  if (reviewed) await workspace.reportService.completeAcceptedReport(taskId);
  else await workspace.reportService.completeCoderReport(taskId);
  const after = await workspace.executionContexts.load(taskId);
  if (after.state !== "terminal") await workspace.executionContexts.update(taskId, after.version, { state: "terminal" });
  await workspace.changeLedger.release();
  return artifact;
}
