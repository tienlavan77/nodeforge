// Separates finding severity from repair authority so serious in-scope defects return to Coder instead of requiring Owner review.
// Retained routing decisions are reconciled without changing independent findings, source identities or historical events.
import { assertCachedReviewResult } from "./recovery-evidence.js";

// Detects an actual repair-scope conflict using the Node-approved baseline rather than a Reviewer severity label.
export function reviewRepairScopeConflict(findings, context) {
  const baseline = context?.approved_baseline?.file_checksums;
  return Boolean(baseline && findings.some((entry) => ((entry.finding ?? entry).files ?? []).some((path) => !Object.hasOwn(baseline, path))));
}

// Replaces only the obsolete severity-based Owner gate while preserving its audit and every real scope boundary.
export function reconcileReviewRepairAuthority(job) {
  if (job.review_result?.payload.owner_decision_reason !== "review_blocker" || job.review_result.type !== "review.request_changes") return job;
  assertCachedReviewResult(job);
  const { owner_decision_reason: previousReason, ...payload } = job.review_result.payload;
  const reason = reviewRepairScopeConflict(payload.findings ?? [], job.payload.execution_context) ? "review_scope_conflict" : null;
  return { ...job, event_id: `${job.event_id}-REPAIR-AUTHORITY`,
    repair_authority_reconciliation: { previous_reason: previousReason, previous_event_id: job.event_id,
      reason, source_revision: job.decision_identity.source_revision },
    parking_outcome: job.parking_outcome?.reason_code === previousReason ? null : job.parking_outcome,
    review_result: { ...job.review_result, payload: { ...payload, ...(reason ? { owner_decision_reason: reason } : {}) } } };
}
