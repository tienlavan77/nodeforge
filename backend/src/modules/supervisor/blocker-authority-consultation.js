// Assigns unresolved permission/contract interpretation to Architecture before SL parks a ticket for external input.
import { createHash } from "node:crypto";

// Binds consultation to the original failure and admitted request, independent of reworded questions or incidental source edits.
function consultationIdentity(job) {
  return createHash("sha256").update(JSON.stringify({ project: job.request?.project_id, task: job.request?.task_id,
    execution: job.request?.payload?.execution_id, job: job.id, failure_at: job.failure_at, reason: job.reason_code,
    admission: job.execution_admission?.receipts ?? job.execution_admission?.sha256 ?? null,
    review_policy: job.execution_admission?.review_policy_version ?? job.admission_review_revision ?? null, architecture: job.architecture_basis ?? null })).digest("hex");
}

// Sends a read-only interpretation question to AM while preserving the denied operation, checkpoint and actual approval gates.
export function assignAuthorityConsultation(job, value, now) {
  const work = value?.reconciliation;
  if (job.stage !== "sprint_leader" || value?.action !== "reconciliation_required"
    || !["execution_admission", "technical_design"].includes(work?.kind)
    || !work.waiting_for?.length || !work.waiting_for.every((entry) => typeof entry === "string" || entry.owner === "external")) return false;
  const answered = job.architecture_response;
  if (answered?.execution_id === job.request?.payload?.execution_id
    && Number.isFinite(Date.parse(job.failure_at)) && answered.answered_at >= Date.parse(job.failure_at)) return false;
  const identity = consultationIdentity(job);
  if (job.authority_consultations?.some((entry) => entry.identity === identity)) return false;
  const request = { identity, status: "assigned", assigned_at: now, original_resolution: value };
  (job.authority_consultations ??= []).push(request);
  const question = work.waiting_for.map((entry) => typeof entry === "string" ? entry : entry.question).join("\n");
  const guidance = `${question}\nDecision needed: ${work.next_check}\nAnswer SL on this unresolved point; do not dispatch Coder, repeat settled decisions or execute the denied operation.`;
  job.consultation_request = { question, decision_needed: work.next_check, known_decision_refs: [], impact: work.prerequisite };
  job.stage = "architecture_manager";
  job.status = "pending";
  job.resolution = { action: "architecture_required", summary: value.summary, guidance, reconciliation: work, evidence: value.evidence };
  job.history.push({ stage: "architecture_manager", event: "authority_consultation_assigned", identity, completed_at: now });
  delete job.outcome_reason;
  delete job.validation_feedback;
  return true;
}

// Records the validated AM answer against this failure so restart or rewording cannot repeat the same consultation.
export function completeAuthorityConsultation(job, value, now) {
  if (job.stage !== "architecture_manager") return;
  const request = job.authority_consultations?.findLast((entry) => entry.status === "assigned" && entry.identity === consultationIdentity(job));
  if (!request) return;
  request.status = "answered";
  request.response = value;
  request.answered_at = now;
}
