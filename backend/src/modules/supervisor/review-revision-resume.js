// Recovers the latest Reviewer findings when a Coder revision needs a fresh SDK turn.

// Rebuilds a revision checkpoint from the durable handoff queue without resuming a completed provider session.
export async function reviewRevisionResume(queueStore, ticketId, checkpoint) {
  if (!checkpoint || ["completed", "blocked"].includes(checkpoint.status) || typeof queueStore?.list !== "function") return checkpoint;
  const jobs = (await queueStore.list("sender.handoff")).filter((job) => job.task_id === ticketId && Array.isArray(job.payload?.review_findings) && job.payload.review_findings.length);
  const revision = jobs.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))).at(-1);
  if (!revision) return checkpoint;
  if ((checkpoint.last_completed_turn ?? 0) > 0 && Array.isArray(checkpoint.review_findings) && JSON.stringify(checkpoint.review_findings) === JSON.stringify(revision.payload.review_findings)) return checkpoint;
  return { task_id: ticketId, status: "in_progress", agent_id: checkpoint.agent_id, provider: checkpoint.provider, changed_paths: [...new Set([...(checkpoint.changed_paths ?? []), ...(revision.payload?.resume_from?.changed_paths ?? [])])], review_findings: revision.payload.review_findings, attempt: revision.attempt, session_id: null, thread_id: null, last_completed_turn: 0, completed_tools: [], turn_history: [], read_cache: {}, coder_rules_read: false };
}

// Continues Reviewer work after a completed Coder checkpoint without dispatching the Coder again.
export function reviewPhaseResume(coderCheckpoint, reviewerCheckpoint) {
  if (coderCheckpoint?.status !== "completed" || !coderCheckpoint.agent_id || !coderCheckpoint.provider) return null;
  if (reviewerCheckpoint?.verdict === "approved") return null;
  const previousAttempt = reviewerCheckpoint?.review_attempt ?? 0;
  const reviewAttempt = reviewerCheckpoint?.verdict === "request_changes" && (coderCheckpoint.attempt ?? 0) > (reviewerCheckpoint.attempt ?? 0)
    ? previousAttempt + 1 : previousAttempt;
  return { agent_id: coderCheckpoint.agent_id, provider: coderCheckpoint.provider, changed_paths: coderCheckpoint.changed_paths ?? reviewerCheckpoint?.changed_paths ?? [], review_attempt: reviewAttempt, base_commit: reviewerCheckpoint?.base_commit ?? null, verification: reviewerCheckpoint?.verification ?? null };
}
