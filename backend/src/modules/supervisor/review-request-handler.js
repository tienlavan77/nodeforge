// Processes Reviewer jobs in the existing agent request queue without a second dispatch queue.
import { ConfigurationError } from "../../shared/errors.js";

// Creates a durable review handler that records one verdict before publishing it to Supervisor.
export function createReviewRequestHandler({ reviewWorker, queueStore, queue, eventBus, projectLogger = () => {} } = {}) {
  if (!queueStore?.save || !queue?.ack || !eventBus?.publish) throw new ConfigurationError("Review request handling requires the agent request queue and event bus.");

  // Reuses a persisted verdict on retry so a Reviewer is never asked twice for one job.
  return async function handleReviewRequest(job) {
    let type; let payload;
    try {
      if (job.review_result) ({ type, payload } = job.review_result);
      else {
        if (!reviewWorker) throw Object.assign(new ConfigurationError("Review Worker is unavailable."), { code: "REVIEW_WORKER_UNAVAILABLE" });
        payload = await reviewWorker.review(job);
        type = payload.verdict === "approved" ? "review.approved" : "review.request_changes";
      }
    } catch (error) {
      type = "review.failed"; payload = { error: { code: error.code ?? "REVIEW_FAILED", message: error.message } };
      projectLogger({ event_name: "review.request_failed", level: "error", status: "failed", message: "Independent ticket review could not complete.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", error_code: payload.error.code, payload: { request_id: job.request_id, error: error.message } });
    }
    await queueStore.save("agent.request", { ...job, review_result: { type, payload } });
    await eventBus.publish({ type, task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload });
    await queue.ack(job.id);
    return { type, payload };
  };
}
