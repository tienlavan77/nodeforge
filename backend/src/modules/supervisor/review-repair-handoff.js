// Scopes operational recovery instructions to their original handoff and directs accepted findings into implementation.

// Retains historical blocker evidence while preventing a later review repair from inheriting obsolete delivery instructions.
export function reviewRepairRecovery(recovery, reviewKey) {
  if (!recovery || recovery.status !== "resolved" || !reviewKey) return recovery ?? null;
  return { ...recovery, status: "superseded_by_review", superseded_by_review: reviewKey };
}

// Applies current finding repair semantics to legacy checkpoints without rewriting their saved authority receipts.
export function resumeRecovery(resume) {
  return resume?.review_repair_key && Array.isArray(resume.review_findings) && resume.review_findings.length
    ? reviewRepairRecovery(resume.blocker_recovery, resume.review_repair_key) : resume?.blocker_recovery;
}

// Distinguishes an actual implementation repair from a justified dispute or an evidence-only explanation.
export function reviewRepairInstructions() {
  return "CURRENT REVIEW REPAIR: these current findings supersede earlier evidence-only or unchanged-source delivery instructions. If you accept an unresolved implementation defect, implement its minimum_change_scope, add focused regressions, commit your ticket changes, and call report_done for the new verified revision. Merely acknowledging the defect through respond_to_review or replaying the old report does not repair it. Use respond_to_review to dispute a finding with concrete evidence, or to explain an evidence-only finding that needs no source change; independent Reviewer decides those positions. Preserve valid Architecture contracts, owner decisions, actual permission denials and unrelated source. Never claim a finding is closed; Reviewer alone adjudicates it.";
}
