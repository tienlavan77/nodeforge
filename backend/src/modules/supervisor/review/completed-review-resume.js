// Resumes Owner-requested review of integrated tickets without reopening terminal Coder contexts.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { dispatchCompletedReviewRepair } from "./completed-review-repair.js";
import { assertReviewRequestOwnership } from "../recovery-evidence.js";
import { matchesAutomaticReviewContext } from "./automatic-review-identity.js";
import { acquireTicketFileLock } from "../ticket/ticket-file-lock.js";

// Identifies historical completion events superseded by an explicit Owner review reopening.
export function isCompletedReviewReopened(job, store) {
  const row = store?.get?.(job.task_id);
  const binding = row?.details?.review_reopen;
  const dependency = row?.details?.dependency_repair;
  if (!binding && dependency && row.details.execution_id === job.payload?.execution_id
    && job.payload?.review_cycle_id !== dependency.id) return true;
  return binding?.job_id === job.id && (row.details.execution_id === job.payload?.execution_id
    || Boolean(binding.repair_cycle_id && binding.commit === job.payload?.verification?.commit_sha && binding.artifact_id === job.payload?.verification?.artifact_id));
}

// Continues retained review only; source files, integration receipts and original review jobs remain unchanged.
export function createCompletedReviewResume({ queueStore, ticketStatusStore, resolveTicketWorkspace, resolveWorker, checkpoints, fileService, resumeRepair, projectLogger = () => {} }) {
  return async ({ projectId, ticketId }) => {
    const lock = await acquireTicketFileLock(fileService, `${statePath()}/automatic-review-locks/OWNER-${ticketId}.lock`);
    try {
      const current = ticketStatusStore.get(ticketId);
      const binding = current?.details?.review_reopen;
      const job = (await queueStore.list("agent.request")).find((entry) => entry.id === binding?.job_id);
      if (current?.project_id !== projectId || current.status !== "reviewing" || !job?.automatic_review || job.review_policy.gate !== "off"
        || job.task_id !== ticketId || job.project_id !== projectId || binding.commit !== job.payload.verification.commit_sha || binding.artifact_id !== job.payload.verification.artifact_id) throw failure("REVIEW_REOPEN_CONFLICT", "Owner review reopening does not match retained evidence.");
      assertReviewRequestOwnership(job, ticketStatusStore);
      const workspace = await resolveTicketWorkspace(ticketId);
      const prior = await checkpoints.loadReview(ticketId);
      if (prior?.status === "completed" && prior.verdict === "request_changes") return await dispatchCompletedReviewRepair({ job, prior, workspace, current, ticketStatusStore, checkpoints, queueStore, resumeRepair, projectLogger });
      const context = await workspace.executionContexts.load(ticketId);
      if (context?.state !== "terminal" || !matchesAutomaticReviewContext(context, job)) throw failure("REVIEW_EVIDENCE_MISMATCH", "Integrated source differs from Owner-selected review evidence.");
      if (prior?.status === "in_progress") throw failure("REVIEW_ATTEMPT_ACTIVE", "Reconcile the previous Reviewer invocation before resuming.");
      const requestId = `OWNER-REVIEW-${ticketId}-${Date.now()}`;
      const review = { ...job, request_id: requestId, correlation_id: `CORR-${requestId}`, finding_snapshot: await workspace.reviewFindings.load() };
      const base = { task_id: ticketId, phase: "review", request_id: requestId, correlation_id: review.correlation_id, review_only: true,
        review_gate: "off", review_attempt: (prior?.review_attempt ?? 0) + 1, changed_paths: job.payload.changed_paths,
        commit: binding.commit, base_commit: job.payload.base_commit, verification: job.payload.verification, verdict: null, last_error: null };
      await checkpoints.saveReview({ ...base, status: "in_progress" });
      try {
        const worker = await resolveWorker(review);
        const result = await worker.review();
        assertReviewRequestOwnership(job, ticketStatusStore);
        if (ticketStatusStore.get(ticketId)?.status !== "reviewing") throw failure("REVIEW_REOPEN_CONFLICT", "Ticket changed during review.");
        await workspace.reviewFindings.recordReview({ ...result, artifactId: binding.artifact_id, commitSha: binding.commit, reviewerId: result.reviewer_id, sourceRevision: job.decision_identity.source_revision });
        if (result.verdict === "approved") await workspace.reviewFindings.assertResolved();
        await checkpoints.completeReview(ticketId, { ...base, ...result });
        const latest = ticketStatusStore.get(ticketId);
        if (result.verdict === "approved") ticketStatusStore.updateStatus(ticketId, "done", { ...latest.details, reason: "owner_reopened_review_approved" }, { expectedCurrentStatus: "reviewing", expectedVersion: latest.version, expectedExecutionId: current.details.execution_id });
        projectLogger({ event_name: "review.owner_resumed", level: "info", status: result.verdict, message: "Owner-requested retained review completed.", task_id: ticketId, correlation_id: review.correlation_id, source: "completed-review-resume", payload: { verdict: result.verdict, findings_count: result.findings.length } });
        if (result.verdict === "request_changes") return await dispatchCompletedReviewRepair({ job, prior: await checkpoints.loadReview(ticketId), workspace,
          current: ticketStatusStore.get(ticketId), ticketStatusStore, checkpoints, queueStore, resumeRepair, projectLogger });
        return { ticket_id: ticketId, status: result.verdict === "approved" ? "completed" : "reviewing", resumed: true, verdict: result.verdict, findings: result.findings, pipeline: "supervisor" };
      } catch (error) {
        if (ticketStatusStore.get(ticketId)?.status === "reviewing" && (await checkpoints.loadReview(ticketId))?.verdict !== "request_changes") await checkpoints.saveReview({ ...base, status: "failed", last_error: { code: error.code ?? "REVIEW_FAILED", message: error.message } });
        throw error;
      }
    } finally { await lock.release(); }
  };
}

// Returns a stable conflict without starting a new Coder or discarding a terminal checkpoint.
function failure(code, message) { return Object.assign(new Error(message), { code, statusCode: 409 }); }
