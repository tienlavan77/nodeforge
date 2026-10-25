/** Describes the actual recovery dispatch capabilities and completed evidence
 * assignments so Architecture can resolve an unowned prerequisite. Legacy text
 * is retained as a question; Node never guesses a role from its wording or kind. */
import { isDeepStrictEqual } from "node:util";

/** Binds a missing-owner consultation to factual coordination progress rather
 * than repeated prose. Formal Reviewer execution is distinct from the existing
 * read-only Coder/Architecture/Reviewer preparation handlers in blocker recovery. */
export function blockerCoordinationEvidence(job, work) {
  if (!work?.waiting_for?.some((entry) => typeof entry === "string")) return null;
  const review = job.ticket_progress?.review_status;
  return { policy: "explicit-waiting-owner-v1", waiting_input_status: "owner_unspecified",
    read_only_preparation_roles: ["coder", "architecture_manager", "reviewer"], independent_reviewer_preparation: "supported",
    formal_review: { status: review?.status ?? "unknown", report_status: review?.report_status ?? "unknown",
      cycle_id: review?.cycle_id ?? null },
    completed_assignments: (job.waiting_work_history ?? []).filter((entry) => entry.status === "answered")
      .map(({ fingerprint, owner, kind }) => ({ fingerprint, owner, kind })) };
}

/** Delivers current dispatcher facts to an existing AM consultation without
 * replaying a rejected decision or changing its original question. Historical
 * capability snapshots stay in the journal rather than controlling new work. */
export function currentBlockerCoordination(job) {
  const request = job.authority_consultations?.findLast((entry) => entry.status === "assigned");
  return request?.coordination_evidence
    ? blockerCoordinationEvidence(job, request.original_resolution?.reconciliation) ?? request.coordination_evidence : null;
}

/** Reopens a known, completed response failure once when dispatcher capability
 * facts have changed. Stop, unknown provider outcomes and unchanged inputs never
 * trigger another invocation; the same AM question and Coder checkpoint remain. */
export function refreshBlockerCoordination(job, now) {
  if (job.stage !== "architecture_manager" || job.status !== "reconciliation_required"
    || !["disposition_correction_no_progress", "disposition_correction_deadline_exhausted", "triage_deadline_exhausted"].includes(job.outcome_reason)) return false;
  const request = job.authority_consultations?.findLast((entry) => entry.status === "assigned");
  const current = currentBlockerCoordination(job);
  if (!current || isDeepStrictEqual(current, request.coordination_evidence)) return false;
  job.history.push({ stage: "architecture_manager", event: "coordination_capabilities_refreshed", completed_at: now,
    previous_coordination_evidence: request.coordination_evidence, previous_feedback: job.validation_feedback ?? [] });
  request.coordination_evidence = current;
  job.resolution = { ...job.resolution, action: "architecture_required" };
  delete job.validation_feedback;
  return true;
}

/** Gives AM one narrow coordination decision without reopening settled scope,
 * fabricating missing evidence, or claiming a formal review can already run. */
export function blockerCoordinationPrompt(evidence) {
  return evidence ? `NODE COORDINATION CAPABILITIES: ${JSON.stringify(evidence)}. The retained waiting_for has no explicit owner. Choose an actionable prerequisite with {owner,operation,question} using the supported handlers, or resolve the technical question within approved authority from available evidence. Independent Reviewer evidence collection is available: AM returns waiting_for:[{owner:reviewer,operation:inspect,question,subject:{commit_sha,artifact_id}}] using an issued receipt. Node calls Reviewer and returns its report to this same AM assignment for decision; AM then answers SL, which coordinates Coder. Formal review remains a separate pipeline stage. Do not require a future formal review report as if it already existed, assign independent Reviewer authorship to Coder, or repeat completed preparation. Preserve actual denials and verification criteria.` : "";
}
