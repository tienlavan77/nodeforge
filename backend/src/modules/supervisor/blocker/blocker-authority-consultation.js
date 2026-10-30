// Assigns unresolved permission/contract interpretation to Architecture before SL parks a ticket for external input.
import { createHash } from "node:crypto";
import { blockerCoordinationEvidence, blockerCoordinationPrompt } from "./blocker-coordination-evidence.js";

// Binds consultation to the original failure and admitted request, independent of reworded questions or incidental source edits.
function consultationIdentity(job, work, evidence = []) {
  const declared = (job.request?.ticket?.execution_policy?.contract_evidence ?? []).map((entry) => entry.path);
  const coordination = blockerCoordinationEvidence(job, work);
  return createHash("sha256").update(JSON.stringify({ project: job.request?.project_id, task: job.request?.task_id,
    execution: job.request?.payload?.execution_id, job: job.id, failure_at: job.failure_at, reason: job.reason_code,
    admission: job.execution_admission?.receipts ?? job.execution_admission?.sha256 ?? null,
    review_policy: job.execution_admission?.review_policy_version ?? job.admission_review_revision ?? null, architecture: job.architecture_basis ?? null,
    kind: work?.kind ?? "technical_design", evidence: evidence.filter((entry) => !declared.length || declared.includes(entry.path))
      .map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    owner_inputs: (job.owner_inputs ?? []).map((entry) => entry.input_id).sort(),
    ...(coordination ? { coordination } : {}) })).digest("hex");
}

// Sends a read-only interpretation question to AM while preserving the denied operation, checkpoint and actual approval gates.
export function assignAuthorityConsultation(job, value, now) {
  if (job.stage !== "sprint_leader" || value?.action !== "reconciliation_required") return false;
  const work = value.reconciliation ?? { kind: "technical_design", prerequisite: value.summary,
    completed_checks: [value.guidance], next_check: value.guidance };
  const coordination = blockerCoordinationEvidence(job, work);
  const identity = consultationIdentity(job, work, value.evidence);
  if (job.authority_consultations?.some((entry) => entry.identity === identity || entry.response_identity === identity)) return false;
  const answered = job.architecture_response;
  if (!coordination && !job.authority_consultations?.length && answered?.execution_id === job.request?.payload?.execution_id && answered.disposition?.action === "reconciliation_required"
    && consultationIdentity(job, answered.disposition.reconciliation, answered.disposition.evidence) === identity) return false;
  const request = { identity, status: "assigned", assigned_at: now, original_resolution: value,
    ...(coordination ? { coordination_evidence: coordination } : {}) };
  (job.authority_consultations ??= []).push(request);
  const question = work.waiting_for?.map((entry) => typeof entry === "string" ? entry : entry.question).join("\n") || work.next_check || work.prerequisite;
  const guidance = `${question}\nDecision needed: ${work.next_check}\n${blockerCoordinationPrompt(coordination)}\nAnswer SL on this unresolved point; do not dispatch Coder, repeat settled decisions or execute the denied operation.`;
  job.consultation_request = { question, decision_needed: coordination
    ? "Choose an executable evidence handoff for the unowned prerequisite using the supplied coordination capabilities; preserve the settled technical contract." : work.next_check,
    known_decision_refs: [], impact: work.prerequisite };
  job.stage = "architecture_manager";
  job.status = "pending";
  job.technical_reconciliation = { ...job.technical_reconciliation, work, assigned_role: "architecture_manager", max_rounds: null };
  job.resolution = { action: "architecture_required", summary: value.summary, guidance, reconciliation: work, evidence: value.evidence };
  job.history.push({ stage: "architecture_manager", event: "authority_consultation_assigned", identity, completed_at: now });
  delete job.outcome_reason;
  delete job.validation_feedback;
  return true;
}

// Records the validated AM answer against this failure so restart or rewording cannot repeat the same consultation.
export function completeAuthorityConsultation(job, value, now) {
  if (job.stage !== "architecture_manager") return;
  let request = job.authority_consultations?.findLast((entry) => entry.status === "assigned");
  const identity = value.action === "reconciliation_required" ? consultationIdentity(job, value.reconciliation, value.evidence) : null;
  if (!request && identity) {
    request = { identity, status: "answered", assigned_at: now };
    (job.authority_consultations ??= []).push(request);
  }
  if (!request) return;
  request.status = "answered";
  request.response_identity = identity;
  request.response = value;
  request.answered_at = now;
}
