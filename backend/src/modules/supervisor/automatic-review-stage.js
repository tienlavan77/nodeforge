// Projects independent review and Coder repair stages onto the original ticket execution.
import { assertReviewRequestOwnership } from "./recovery-evidence.js";

// Updates the ticket stage without replacing execution identity or accepting an unreviewed revision.
export function setAutomaticReviewStage(job, ticketStatusStore, status) {
  if (job.review_policy.gate !== "on" || !ticketStatusStore?.get) return;
  assertReviewRequestOwnership(job, ticketStatusStore);
  const current = ticketStatusStore.get(job.task_id);
  if (!current || current.status === status) return;
  if (!["running", "reviewing"].includes(current.status)) throw Object.assign(new Error("Ticket is not active for independent review or repair."), { code: "REVIEW_STATUS_INVALID" });
  ticketStatusStore.updateStatus(job.task_id, status, { ...current.details,
    reason: status === "reviewing" ? "automatic_review" : "review_request_changes" },
  { expectedCurrentStatus: current.status, expectedVersion: current.version,
    ...(current.details?.execution_id ? { expectedExecutionId: current.details.execution_id } : {}) });
}

// Saves a Reviewer checkpoint after the ticket has visibly entered its review stage.
export async function beginAutomaticReview(job, ticketStatusStore, checkpoints) {
  setAutomaticReviewStage(job, ticketStatusStore, "reviewing");
  const previous = await checkpoints?.loadReview?.(job.task_id);
  const verification = previous?.review_verification;
  await checkpoints?.saveReview?.({ task_id: job.task_id, phase: "review", status: "in_progress", verdict: null,
    attempt: job.attempt ?? 1, review_attempt: (job.outcomes?.length ?? 0) + 1, request_id: job.request_id,
    correlation_id: job.correlation_id, review_gate: job.review_policy.gate, changed_paths: job.payload?.changed_paths ?? [],
    base_commit: job.payload?.base_commit ?? null, commit: job.payload?.commit ?? null,
    verification: job.payload?.verification ?? null, execution_context: job.payload?.execution_context ?? null, last_error: null, operational_retry: null,
    ...(verification?.binding?.artifact_id === job.payload?.verification?.artifact_id && verification.binding.execution_id === job.payload?.execution_id
      ? { review_verification: verification } : {}) });
}

// Prevents RUN from duplicating a Reviewer invocation whose provider outcome is still unknown.
export async function assertAutomaticReviewResume(queueStore, taskId, executionId) {
  if (!queueStore?.list) return;
  const jobs = await queueStore.list("agent.request");
  if (jobs.some((job) => job.automatic_review && job.task_id === taskId && (job.running_attempt && !job.review_result || ["pending", "retrying"].includes(job.operational_retry?.status) && !job.review_result?.payload.verdict)
    && job.payload?.execution_id === executionId)) {
    throw Object.assign(new Error("Reviewer attempt is active or awaiting provider reconciliation; RUN cannot start another review."),
      { code: "REVIEW_ATTEMPT_ACTIVE", statusCode: 409 });
  }
}
