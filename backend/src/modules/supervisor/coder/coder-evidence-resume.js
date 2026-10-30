// Restores Coder execution when an old successful report still lacks acceptance evidence.

// Resumes the existing work and report without treating missing evidence as completed review work.
export function coderEvidenceResume(checkpoint, report) {
  if (checkpoint?.status !== "completed" || report?.status !== "submitted_for_review") return null;
  const pending = report.criteria_check?.filter((entry) => entry.status === "evidence_pending") ?? [];
  if (!pending.length) return null;
  const resume = { ...checkpoint };
  delete resume.completed_at;
  return {
    ...resume,
    status: "in_progress",
    phase: "coder_evidence_required",
    pending_criterion_ids: pending.map((entry) => entry.criterion_id).filter(Boolean),
    completed_tools: (checkpoint.completed_tools ?? []).filter((tool) => tool !== "report_done"),
    turn_history: (checkpoint.turn_history ?? []).filter((entry) => entry.tool !== "report_done")
  };
}
