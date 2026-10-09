// Processes Reviewer jobs in the existing agent request queue without a second dispatch queue.
import { ConfigurationError } from "../../shared/errors.js";
import { isDeepStrictEqual } from "node:util";
import { assertCachedReviewResult, assertReviewRequestOwnership, reviewRequestBasis } from "./recovery-evidence.js";

// Creates a durable review handler that records one verdict before publishing it to Supervisor.
export function createReviewRequestHandler({ reviewWorker, resolveReviewWorker, resolveReviewFindings, checkpointStore, queueStore, queue, eventBus, projectLogger = () => {}, ticketStatusStore, validateReviewEvidence } = {}) {
  if (!queueStore?.save || !queue?.ack || !eventBus?.publish) throw new ConfigurationError("Review request handling requires the agent request queue and event bus.");

  // Reuses a persisted verdict on retry so a Reviewer is never asked twice for one job.
  return async function handleReviewRequest(job) {
    const basis = reviewRequestBasis(job);
    assertReviewRequestOwnership(job, ticketStatusStore);
    assertCachedReviewResult(job);
    if (job.review_result && job.review_result.type !== "review.failed") await validateReviewEvidence?.(job);
    let type; let payload;
    try {
      if (job.review_result) ({ type, payload } = job.review_result);
      else {
        const worker = resolveReviewWorker ? await resolveReviewWorker(job) : reviewWorker;
        if (!worker) throw Object.assign(new ConfigurationError("Review Worker is unavailable."), { code: "REVIEW_WORKER_UNAVAILABLE" });
        payload = await worker.review(job);
        if (resolveReviewFindings) {
          const findingsStore = await resolveReviewFindings(job);
          assertReviewRequestOwnership(job, ticketStatusStore);
          if (!isDeepStrictEqual(basis, reviewRequestBasis(job))) throw Object.assign(new ConfigurationError("Review request evidence changed during review."), { code: "EXECUTION_RECONCILIATION_CONFLICT", retryable: false });
          await validateReviewEvidence?.({ ...job, review_result: { payload } });
          assertReviewRequestOwnership(job, ticketStatusStore);
          await findingsStore.recordReview({ verdict: payload.verdict, findings: payload.findings, adjudications: payload.adjudications, artifactId: job.payload?.verification?.artifact_id ?? job.payload?.verification_artifact_id, commitSha: job.payload?.verification?.commit_sha ?? job.payload?.commit_sha, reviewerId: payload.reviewer_id, sourceRevision: payload.source_revision });
        }
        type = payload.verdict === "approved" ? "review.approved" : "review.request_changes";
      }
    } catch (error) {
      if (error.code === "EXECUTION_RECONCILIATION_CONFLICT") throw error;
      type = "review.failed"; payload = { error: { code: error.code ?? "REVIEW_FAILED", message: error.message } };
      projectLogger({ event_name: "review.request_failed", level: "error", status: "failed", message: "Independent ticket review could not complete.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", error_code: payload.error.code, payload: { request_id: job.request_id, error: error.message } });
    }
    assertReviewRequestOwnership(job, ticketStatusStore);
    if (!isDeepStrictEqual(basis, reviewRequestBasis(job))) throw Object.assign(new ConfigurationError("Review request evidence changed during review."), { code: "EXECUTION_RECONCILIATION_CONFLICT", retryable: false });
    await queueStore.save("agent.request", { ...job, review_result: { type, payload, basis } });
    assertReviewRequestOwnership(job, ticketStatusStore);
    if (type === "review.approved" || type === "review.request_changes") {
      await checkpointStore?.completeReview?.(job.task_id, { phase: "review", request_id: job.request_id, correlation_id: job.correlation_id, reviewer_id: payload.reviewer_id, verdict: payload.verdict, findings: payload.findings, adjudications: payload.adjudications ?? [], verification: job.payload?.verification ?? null, changed_paths: job.payload?.changed_paths ?? [] });
    } else {
      await checkpointStore?.saveReview?.({ task_id: job.task_id, phase: "review", status: "failed", request_id: job.request_id, correlation_id: job.correlation_id, last_error: payload.error ?? { code: "REVIEW_FAILED" } });
    }
    assertReviewRequestOwnership(job, ticketStatusStore);
    await eventBus.publish({ type, task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload });
    await queue.ack(job.id);
    return { type, payload };
  };
}
