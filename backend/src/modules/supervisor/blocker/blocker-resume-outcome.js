/** Separates a completed Coder handoff from a retryable dispatch failure. A
 * Coder that returns a new blocker has consumed its assignment; replaying the
 * old resolved decision cannot perform missing cross-ticket coordination. */
import { isDeepStrictEqual } from "node:util";
import { blockerValidationError } from "./blocker-validation.js";

/** Finishes only launched assignments that returned a structured Coder blocker.
 * Agent occupancy errors and unknown provider outcomes keep their own recovery
 * paths; the new Coder failure is captured independently at its checkpoint. */
export function completeBlockedResume(job, error, operation, now) {
  if (!["resume_pending", "approval_retry_pending"].includes(operation) || error.code !== "CODER_BLOCKED") return false;
  job.status = "resumed";
  job.resume_outcome = { status: "blocked", code: error.code, reason_code: error.details?.blocker?.reason_code ?? null,
    message: error.message, completed_at: now };
  job.history.push({ stage: "coder", event: "resumed_coder_blocked", ...job.resume_outcome });
  delete job.agent_wait;
  delete job.outcome_reason;
  return true;
}

/** Carries the last failed assignment into SL's next question without reusing
 * its authority as a new decision or confusing message wording with progress. */
export function previousBlockedHandoff(ledger, input) {
  const previous = ledger.jobs.findLast((job) => job.resolution?.action === "resolved"
    && (job.status === "dispatching" || job.resume_outcome?.status === "blocked"
      || job.validation_feedback?.some((entry) => entry.reason === "CODER_BLOCKED"))
    && job.request.execution_context?.source_revision === input.request.execution_context?.source_revision
    && job.failure_at !== input.failure_at && job.reason_code === input.reason_code);
  return previous ? { job_id: previous.id, reason_code: input.reason_code,
    disposition: structuredClone(previous.resolution) } : null;
}

/** Reopens a failed legacy handoff as an SL question rather than repeating the
 * same dispatch on explicit Resume. Provider-unknown and occupancy waits are
 * deliberately excluded because they do not prove a completed Coder result. */
export function restoreBlockedHandoff(job, ledger, now) {
  const blocked = job.resolution?.action === "resolved"
    && job.validation_feedback?.some((entry) => entry.reason === "CODER_BLOCKED");
  job.previous_handoff ??= blocked ? { job_id: job.id, reason_code: job.reason_code,
    disposition: structuredClone(job.resolution) } : previousBlockedHandoff(ledger, job);
  if (!blocked) return;
  job.history.push({ stage: "sprint_leader", event: "blocked_handoff_returned_to_sprint", completed_at: now });
  job.stage = "sprint_leader";
  delete job.resolution;
}

/** Rejects an unchanged scope handoff after Coder has already proved it cannot
 * proceed. SL can supply a changed actionable decision or an explicit wait;
 * a rewritten summary alone is not a new dispatch instruction. */
export function assertBlockerHandoffProgress(value, job) {
  const previous = job?.previous_handoff;
  if (value.action !== "resolved" || job?.stage !== "sprint_leader" || job.reason_code !== "SCOPE_CONFLICT"
    || previous?.reason_code !== job.reason_code) return;
  // Defines instruction function behavior for blocker-resume-outcome.js.
  const instruction = (entry) => ({ guidance: entry.guidance, technical_result: entry.technical_result,
    evidence: [...(entry.evidence ?? [])].sort((left, right) => left.path.localeCompare(right.path)) });
  if (isDeepStrictEqual(instruction(value), instruction(previous.disposition))) throw blockerValidationError("/action", "blocked_handoff_unchanged",
    "Coder already returned SCOPE_CONFLICT for this exact handoff and source. Do not redispatch it by changing the summary. Supply a different executable instruction within this ticket, or reconciliation_required with the exact dependency, missing result and responsible owner. resolved dispatches only this ticket's Coder; it does not repair or message another ticket's Supervisor.");
}
