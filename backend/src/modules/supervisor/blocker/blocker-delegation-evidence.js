// Routes changed evidence in a retained Architecture decision to its author while preserving SL's proposed handoff and the Coder checkpoint.
import { createHash } from "node:crypto";
import { blockerValidationError } from "./blocker-validation.js";

// Collects every changed AM citation in one bounded diagnostic so SL never receives correction instructions for another role's decision.
export async function assertDelegationEvidence(evidence, validate) {
  const changes = [];
  for (const [index, reference] of evidence.entries()) {
    try { await validate([reference]); }
    catch (error) {
      if (error.code !== "BLOCKER_DISPOSITION_INVALID" || !error.validation_errors?.every((entry) => ["evidence_stale", "evidence_missing"].includes(entry.reason))) throw error;
      changes.push(...error.validation_errors.map((entry) => ({ ...entry,
        path: entry.path.replace(/^\/evidence\/0/, `/sprint_delegation/evidence/${index}`), source_path: reference.path,
        decision_owner: "architecture_manager" })));
    }
  }
  if (!changes.length) return;
  throw Object.assign(blockerValidationError(changes[0].path, changes[0].reason,
    "Retained Architecture evidence changed; AM must reconcile these citations before SL can consume the decision."),
  { delegation_evidence_changed: true, validation_errors: changes });
}

// Creates a focused, execution-bound AM assignment from verified source drift rather than inventing a replacement approval or retrying SL's JSON.
export function assignDelegationEvidenceReview(job, error, now) {
  if (job.stage !== "sprint_leader" || !job.sprint_delegation || !error.delegation_evidence_changed) return false;
  const changes = error.validation_errors;
  const identity = createHash("sha256").update(JSON.stringify([job.id, job.request.payload.execution_id, job.sprint_delegation, changes])).digest("hex");
  if (job.delegation_evidence_review?.identity === identity) return false;
  const handoff = job.disposition_attempts?.findLast((entry) => entry.stage === "sprint_leader" && entry.response?.text);
  job.delegation_evidence_review = { identity, status: "assigned", assigned_at: now, changes,
    handoff: handoff ? { assignment_id: handoff.assignment_id, response_sha256: handoff.response.sha256 } : null };
  const question = `Only reconcile the changed citations supporting your retained decision: ${JSON.stringify(changes)}. `
    + "Read these original files using existing source tools. Decide whether the prior technical conclusion still applies; return current relevant evidence and concrete guidance to SL. Do not repeat unrelated discovery or rewrite historical evidence.";
  job.consultation_request = { question,
    decision_needed: "Reaffirm the retained Architecture conclusion against current inspected source, or identify the specific changed implementation prerequisite.",
    known_decision_refs: [{ section: "architecture_response", answered_at: job.architecture_response?.answered_at }],
    impact: "SL has already proposed a handoff. Preserve its decision, completed dependency results and the Coder checkpoint; only AM's supporting source citations require reconciliation." };
  job.resolution = { action: "architecture_required", summary: "Reconcile changed evidence in the retained Architecture decision.", guidance: question };
  job.history.push({ stage: "architecture_manager", event: "delegation_evidence_review_assigned", identity, completed_at: now });
  job.stage = "architecture_manager";
  job.status = "pending";
  delete job.validation_feedback;
  delete job.outcome_reason;
  delete job.last_error;
  return true;
}

// Rechecks legacy parked jobs under the normal execution fences before correcting their misattributed evidence failure.
export async function refreshDelegationEvidence(job, { checkDelegation, clock, projectLogger }) {
  if (job.stage !== "sprint_leader" || !job.sprint_delegation || typeof checkDelegation !== "function"
    || ["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(job.outcome_reason)
    || !job.validation_feedback?.some((entry) => ["evidence_stale", "evidence_missing"].includes(entry.reason))) return false;
  try { await checkDelegation(job); }
  catch (error) {
    if (!error.delegation_evidence_changed) throw error;
    if (!assignDelegationEvidenceReview(job, error, clock())) return false;
    projectLogger({ event_name: "supervisor.blocker_delegation_evidence_changed", level: "info", status: "pending",
      task_id: job.request.task_id, project_id: job.request.project_id,
      message: "Changed Architecture citations assigned to AM; retained Sprint handoff and Coder checkpoint preserved.",
      payload: { job_id: job.id, changes: error.validation_errors } });
    return true;
  }
  return false;
}
