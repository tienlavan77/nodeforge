// Separates historical ticket evidence from unfinished recovery work using persisted lifecycle state.
// Completed records remain available to explicit review reopening without replaying their side effects at startup.

// Recognizes a finished project ticket only after its provider launch ownership has been reconciled.
// Missing or foreign-project state never authorizes recovery to silently discard unfinished work.
export function isTicketRecoveryCompleted(record, ticketStatusStore) {
  const current = ticketStatusStore?.get?.(record.task_id);
  return Boolean(record.project_id && current?.project_id === record.project_id
    && current.status === "done" && !current.details?.launch_claim);
}

// Excludes acknowledged review outcomes from startup replay after ticket completion is durable.
// Deferred publication, integration gaps and configured operational retries still need recovery even when Coder is done.
export function isAutomaticReviewCompleted(job, ticketStatusStore, { operationalRetry = true } = {}) {
  if (job.status !== "completed" || !job.review_result || !isTicketRecoveryCompleted(job, ticketStatusStore)) return false;
  return !(operationalRetry && job.review_result.payload?.error?.retryable && job.operational_retry?.status !== "cancelled");
}
