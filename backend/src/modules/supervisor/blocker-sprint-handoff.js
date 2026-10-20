// Returns implementation recovery to Sprint Leader while preserving Architecture decisions and the original execution.
import { assignWaitingWork } from "./blocker-waiting-work.js";
import { requiresBlockerAdmission } from "./blocker-failure-classification.js";
const IMPACTS = ["changes_structure", "changes_owner_scope", "changes_security_policy", "changes_data_semantics", "overrides_guardrails", "changes_ticket_contract"];
const IMPLEMENTATION_KINDS = ["source_revision", "dependency", "file_claim", "tooling"];

// Selects Sprint coordination for implementation work without delegating access, security or contract design.
export function sprintRecoveryWork(job, work) {
  const assessment = job.history?.findLast((entry) => entry.stage === "architecture_manager" && entry.disposition?.boundary_assessment)?.disposition.boundary_assessment;
  return !job.fulfillment_decision_id && job.reason_code !== "SECURITY_RISK"
    && (!requiresBlockerAdmission(job) || assessment && IMPACTS.every((field) => assessment[field] === false))
    && IMPLEMENTATION_KINDS.includes(work?.kind);
}

// Preserves the previous consultation and assigns implementation coordination without approving Coder execution.
export function delegateSprintRecovery(job, value, now) {
  job.history.push({ stage: job.stage, event: "sprint_recovery_assigned", completed_at: now,
    previous_exchange: job.coder_exchange ? structuredClone(job.coder_exchange) : null, previous_resolution: job.resolution ?? null, guidance: value.guidance });
  if (job.coder_exchange) job.coder_exchange.review_role = "sprint_leader";
  delete job.validation_feedback;
  job.stage = "sprint_leader";
  job.status = "pending";
  job.resolution = value;
  if (value.architecture_basis) job.sprint_delegation = value;
  if (job.technical_reconciliation) job.technical_reconciliation.assigned_role = "sprint_leader";
}

// Restores legacy implementation consultations at SL on explicit resume, retaining all earlier AM evidence in history.
export function restoreSprintRecovery(job, now) {
  if (job.stage === "sprint_leader" && job.resolution?.action === "reconciliation_required"
    && assignWaitingWork(job, job.resolution, now)) return;
  if (job.stage === "coder" && job.coder_exchange?.review_role !== "sprint_leader" && job.coder_exchange) {
    job.coder_exchange.review_role = "sprint_leader";
    job.history.push({ stage: "coder", event: "sprint_coder_coordination_restored", request_id: job.coder_exchange.request_id, completed_at: now });
  }
  if (job.stage !== "architecture_manager" || !sprintRecoveryWork(job, job.technical_reconciliation?.work)) return;
  delegateSprintRecovery(job, { action: "sprint_required", summary: "Continue implementation coordination within the approved ticket.",
    guidance: "SL must reassess the actual implementation prerequisite against the ticket criteria and request a focused Coder proposal. Prior audit requests are observations, not added acceptance criteria. Preserve approval denials and Architecture decisions; escalate only a concrete Architecture/contract decision." }, now);
}
