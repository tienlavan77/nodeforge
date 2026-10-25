/** Coordinates Architecture's independent evidence requests without entering
 * formal ticket review. Each request retains its source binding and report so
 * Stop/Resume can continue the investigation and AM alone decides its outcome. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertAgentExchangePayload, createAgentExchange } from "../governance/agent-exchange.js";
import { blockerValidationError } from "./blocker-validation.js";

/** Selects the explicitly owned Reviewer question; narrative never dispatches
 * a role, and one independent source-bound question runs per AM assignment. */
export function reviewerEvidenceRequest(value) {
  return value?.reconciliation?.waiting_for?.find((entry) => entry?.owner === "reviewer");
}

/** Validates the read-only request and prevents completed report collection
 * from being replayed merely because AM returned the same prerequisite again. */
export function validateReviewerEvidenceRequest(value, job) {
  const request = reviewerEvidenceRequest(value);
  if (!request) return;
  if (value.action !== "reconciliation_required" || value.reconciliation.waiting_for.filter((entry) => entry?.owner === "reviewer").length !== 1)
    throw blockerValidationError("/reconciliation/waiting_for", "reviewer_request_invalid", "Use one independent Reviewer inspection per reconciliation.");
  if (job.stage === "architecture_manager" && [job.reviewer_evidence, ...(job.reviewer_evidence_history ?? [])].some((entry) => entry?.status === "completed"
    && isDeepStrictEqual(request, entry.request)))
    throw blockerValidationError("/reconciliation/waiting_for", "reviewer_report_already_available", "The independent report is already available in reviewer_evidence. Decide from that report instead of requesting it again.");
}

/** Reserves AM's nested Reviewer investigation in the original recovery job,
 * retaining the pending SL consultation and Coder execution checkpoint. */
export function assignReviewerEvidence(job, value, now) {
  if (job.stage !== "architecture_manager") return false;
  const request = reviewerEvidenceRequest(value);
  if (!request) return false;
  validateReviewerEvidenceRequest(value, job);
  const id = createHash("sha256").update(JSON.stringify([job.id, job.request.payload.execution_id, request.subject, request.question])).digest("hex");
  job.reviewer_evidence_history ??= [];
  if (job.reviewer_evidence) job.reviewer_evidence_history.push(job.reviewer_evidence);
  job.reviewer_evidence = { id, request, status: "pending", assigned_at: now, architecture_request: value,
    architecture_actor: job.invocation_actor ?? job.history.at(-1)?.actor ?? null };
  job.stage = "reviewer"; job.status = "pending";
  job.history.push({ stage: "reviewer", event: "reviewer_evidence_assigned", request_id: id, completed_at: now });
  delete job.outcome_reason; delete job.validation_feedback;
  return true;
}

/** Builds the shared review transport from AM to Reviewer with an explicit
 * evidence purpose, which never authorizes formal approval or finding closure. */
export function blockerReviewerExchange(job, profile) {
  const work = job.reviewer_evidence;
  return createAgentExchange({ context: { project_id: job.request.project_id, ticket_id: job.request.task_id, execution_id: job.request.payload.execution_id },
    sender: { role: "architecture_manager", agent_id: work.architecture_actor?.agent_id ?? null }, recipient: { role: "reviewer", agent_id: profile.agent_id },
    kind: "review_request", subject: work.request.question, payload: { purpose: "blocker_evidence", question: work.request.question, subject: work.request.subject,
      source_ref: work.request.subject.commit_sha, criterion_ids: [], report_ref: null, finding_refs: [] },
    continuation: { assignment_id: work.id, checkpoint_ref: null } });
}

/** Checks the independent result shape and binding even when an injected
 * worker bypasses the SDK envelope adapter; factual source checks run separately. */
export function validateReviewerEvidenceResult(value, job) {
  if (job.stage !== "reviewer" || !job.reviewer_evidence || value?.action !== "review_evidence_provided")
    throw blockerValidationError("/action", "reviewer_result_required", "Return the requested evidence-only review_result, not an authority decision.");
  try { assertAgentExchangePayload("review_result", value.review_evidence); }
  catch (error) { throw blockerValidationError(error.validation_errors?.[0]?.path ?? "/review_evidence", "reviewer_result_invalid", error.message); }
  if (value.review_evidence.purpose !== "blocker_evidence"
    || !isDeepStrictEqual(value.review_evidence.subject, job.reviewer_evidence.request.subject)
    || Buffer.byteLength(JSON.stringify(value)) > 24_000)
    throw blockerValidationError("/review_evidence", "reviewer_result_invalid", "Return a bounded report for the assigned commit and artifact.");
  if (value.review_evidence.outcome === "inconclusive" && !value.review_evidence.missing_evidence.length)
    throw blockerValidationError("/review_evidence/missing_evidence", "missing_evidence_required", "Name the evidence missing from an inconclusive result.");
  return value;
}

/** Returns independent facts to the same waiting AM assignment. No SL/Coder
 * dispatch, formal review verdict or verification acceptance occurs here. */
export function returnReviewerEvidence(job, value, now) {
  if (job.stage !== "reviewer") return false;
  validateReviewerEvidenceResult(value, job);
  Object.assign(job.reviewer_evidence, { status: "completed", completed_at: now, result: value.review_evidence,
    evidence: value.evidence ?? [], report_ref: job.communication?.response_ref ?? null });
  job.stage = "architecture_manager"; job.status = "pending";
  job.history.push({ stage: "architecture_manager", event: "reviewer_evidence_returned", request_id: job.reviewer_evidence.id, completed_at: now });
  delete job.validation_feedback; delete job.outcome_reason;
  return true;
}

/** Keeps each role focused on the nested report's meaning, with AM retaining
 * technical decision authority and formal Coder/Reviewer repair kept separate. */
export function blockerReviewerPrompt(job) {
  const work = job.reviewer_evidence;
  if (job.stage === "reviewer") return "INDEPENDENT BLOCKER EVIDENCE: Answer only the assigned question using the fixed commit and artifact. Return review_result with purpose=blocker_evidence, the exact subject, outcome=completed|inconclusive, summary, observations, missing_evidence, findings:[], finding_updates:[]. Supply checksummed evidence references. Do not return verdict, repair code, run tests, weaken assertions, replay denied diagnostics or approve ticket acceptance. Missing facts are explicit, never invented.";
  return work?.status === "completed" ? `INDEPENDENT REVIEWER REPORT RETURNED TO AM: ${JSON.stringify({ request: work.request, result: work.result, evidence: work.evidence, report_ref: work.report_ref })}. Decide the retained technical question now from these observations and their limitations. Do not request the same report again or repeat repository discovery without a specific new uncertainty. Return your decision to SL; only SL hands implementation to Coder. This report is not formal review approval or verification PASS.`
    : job.stage === "architecture_manager" ? "AM may request independent factual inspection using reconciliation_required with waiting_for:[{owner:reviewer,operation:inspect,question,subject:{commit_sha,artifact_id}}]. Choose the exact commit/artifact from verification.receipt_index. Reviewer returns its report directly to AM, which must decide before returning guidance to SL. This does not run formal review or authorize tests/edits." : "";
}
