// Applies accepted coordination decisions without changing which role owns implementation or approval.
import { transitionCoderCandidate } from "./blocker-coder-candidate.js";
import { scheduleTechnicalReconciliation } from "./blocker-technical-reconciliation.js";
import { returnArchitectureResponse } from "./blocker-architecture-response.js";
import { completeWaitingWork } from "./blocker-waiting-work.js";
import { recordCriterionUpdates } from "./blocker-ticket-progress.js";
import { assignReviewerEvidence, returnReviewerEvidence } from "./blocker-reviewer-evidence.js";

// Parks dependency execution separately from research so unchanged waits never re-invoke AM or the blocked Coder.
export function applyBlockerDisposition(current, value, now, dependencyRequestId) {
  current.disposition_attempts.at(-1).status = "accepted";
  if (current.stage === "sprint_leader" && value.action === "architecture_required") current.consultation_request = current.communication?.consultation ?? null;
  delete current.validation_feedback; delete current.last_error;
  current.history.push({ stage: current.stage, disposition: value, completed_at: now, actor: current.invocation_actor ?? null });
  recordCriterionUpdates(current, value);
  if (current.dependency_result) current.dependency_result_consumed = true;
  if (value.action === "dependency_requested") {
    current.resolution = value; current.status = dependencyRequestId ? "dependency_wait" : "dependency_request_pending"; current.dependency_request_id = dependencyRequestId;
    return;
  }
  completeWaitingWork(current, value, now);
  if (assignReviewerEvidence(current, value, now) || returnReviewerEvidence(current, value, now)) return;
  if (returnArchitectureResponse(current, value, now) || transitionCoderCandidate(current, value, now)) return;
  if (value.action === "resolved") { current.resolution = value; current.status = "resume_pending"; }
  else if (value.action === "reconciliation_required") scheduleTechnicalReconciliation(current, value, now);
  else if (current.stage === "sprint_leader") { current.resolution = value; current.stage = "architecture_manager"; current.status = "pending"; }
  else if (["owner_required", "governance_required"].includes(value.action)) {
    current.resolution = value; current.status = "notification_pending";
    current.outcome_reason = value.action === "governance_required" ? "contract_revision_required" : "authority_required";
  } else { current.status = "notification_pending"; current.outcome_reason = "unresolved_after_architecture"; }
}
