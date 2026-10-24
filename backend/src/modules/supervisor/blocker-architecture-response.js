// Returns Architecture consultation answers to Sprint Leader without dispatching Coder or approving execution.
import { completeAuthorityConsultation } from "./blocker-authority-consultation.js";
import { scheduleTechnicalReconciliation } from "./blocker-technical-reconciliation.js";
import { waitingAssignments } from "./blocker-waiting-work.js";
import { completeBlockerAdmissionWait } from "./blocker-handoff-policy.js";

// Preserves the AM conclusion as SL input, retaining the original Coder request and checkpoint.
export function returnArchitectureResponse(job, value, now) {
  if (job.stage !== "architecture_manager") return false;
  completeAuthorityConsultation(job, value, now);
  if (!["resolved", "sprint_required", "reconciliation_required"].includes(value.action)) return false;
  job.architecture_response = { disposition: value, answered_at: now, execution_id: job.request.payload?.execution_id,
    actor: job.history.at(-1)?.actor ?? null };
  if (["resolved", "sprint_required"].includes(value.action) && value.authority_scope === "architecture") job.sprint_delegation = value;
  else delete job.sprint_delegation;
  if (job.coder_exchange) job.coder_exchange.review_role = "sprint_leader";
  job.stage = "sprint_leader";
  job.status = "pending";
  job.resolution = value;
  job.history.push({ stage: "sprint_leader", event: "architecture_answer_returned", action: value.action, completed_at: now });
  if (value.execution_admission_request) job.execution_admission = value.execution_admission_request;
  if (value.action === "resolved" && value.authority_scope === "architecture") completeBlockerAdmissionWait(job, now);
  if (value.action === "reconciliation_required" && !value.reconciliation?.waiting_for?.length) {
    scheduleTechnicalReconciliation(job, value, now);
    job.stage = "sprint_leader";
    job.status = "pending";
  } else if (value.action === "reconciliation_required" && value.reconciliation) {
    job.technical_reconciliation = { ...job.technical_reconciliation, work: value.reconciliation,
      round: (job.technical_reconciliation?.round ?? 0) + 1, assigned_role: "sprint_leader", max_rounds: null };
    job.waiting_assignments = waitingAssignments(value.reconciliation);
  }
  delete job.outcome_reason;
  return true;
}
