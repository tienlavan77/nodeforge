/** Identifies legacy preparation failures that stopped an already resolved
 * Coder handoff. This narrow recovery excludes Stop, unknown SDK outcomes and
 * unresolved agent decisions, preserving normal execution authority checks. */

/** Selects only parked retry preparation faults, never an owner cancellation.
 * Live ownership is revalidated separately before the job can be dispatched. */
export function isBlockerSourceRetry(job) {
  return ["cancelled", "reconciliation_required"].includes(job.status)
    && job.resolution?.action === "resolved" && job.source_retry_policy !== "agent-source-retry-v1"
    && ["stale_execution_or_source", "TICKET_EXECUTION_RECONCILIATION_REQUIRED"].includes(job.outcome_reason)
    && job.validation_feedback?.some((entry) => entry.reason === "TICKET_EXECUTION_RECONCILIATION_REQUIRED");
}
