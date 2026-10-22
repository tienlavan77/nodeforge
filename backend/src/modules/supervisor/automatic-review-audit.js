// Publishes stable review outcomes and creates independent deduplicated backlog tickets for post-completion findings.
import { reviewDigest } from "./automatic-review-identity.js";

// Keeps a distinct immutable parking audit per operational attempt while deduplicating replayed terminal events.
export async function publishAutomaticReviewParking({ job, reason, queueStore, eventBus, locked, load }) {
  const retryable = job.review_result?.payload.error?.retryable === true;
  const outcome = await locked(async () => {
    const current = await load(job.id);
    const attemptId = current.outcomes?.at(-1)?.attempt_id ?? `${current.request_id}-PREPARE`;
    const history = current.parking_outcomes ?? (current.parking_outcome ? [current.parking_outcome] : []);
    const existing = history.find((entry) => entry.attempt_id === attemptId && entry.reason_code === reason);
    if (existing) return existing;
    const suffix = reviewDigest({ job_key: current.job_key, attempt_id: attemptId, reason }).slice(7);
    const next = { job_key: current.job_key, attempt_id: attemptId, outcome_label: retryable ? "review_retry_pending" : reason === "review_revision_limit" ? "review_revision_limit" : "needs_human_review",
      reason_code: reason, source_revision: current.decision_identity.source_revision, created_at: new Date().toISOString(), event_id: `EVT-LIMIT-${suffix}`, parking_event_id: `EVT-PARK-${suffix}` };
    await queueStore.save("agent.request", { ...current, parking_outcome: next, parking_outcomes: [...history, next] });
    return next;
  });
  const envelope = { task_id: job.task_id, project_id: job.project_id, supervisor_id: job.supervisor_id, request_id: job.source_request.request_id, correlation_id: job.correlation_id, attempt: job.attempt };
  if (reason === "review_revision_limit") await eventBus.publish({ ...envelope, type: "review.revision_limit", event_id: outcome.event_id, payload: { job_key: job.job_key, reason } });
  await eventBus.publish({ ...envelope, type: retryable ? "task.failed" : "task.needs_human_review", event_id: outcome.parking_event_id ?? `EVT-PARK-${job.request_id}`, payload: { reason, ...(retryable ? { retryable: true, resume_stage: "reviewer", error: job.review_result.payload.error } : {}), job_key: job.job_key, execution_id: job.source_request.payload?.execution_id, execution_basis: job.source_request.payload?.sprint_basis } });
  return { status: retryable ? "failed" : "needs_human_review", reason };
}

// Replays persisted event intent without mutating a completed ticket or fabricating a Reviewer verdict.
export async function publishAutomaticReviewOutcome({ job, queueStore, queue, eventBus, checkpoints, repairCount, locked }) {
  const soft = job.review_policy.gate === "off";
  const deferredMinorOnApprove = job.review_result.type === "review.approved" && Array.isArray(job.review_result.payload.findings)
    && job.review_result.payload.findings.some((finding) => String(finding?.severity ?? "").toLowerCase() === "minor" && finding?.defer_to_backlog === true);
  if ((soft && job.review_result.type === "review.request_changes") || deferredMinorOnApprove) {
    for (const [index, finding] of job.review_result.payload.findings.entries()) {
      if (deferredMinorOnApprove && (String(finding?.severity ?? "").toLowerCase() !== "minor" || finding?.defer_to_backlog !== true)) continue;
      const findingId = finding.finding_id ?? finding.id ?? `REV-${index + 1}`;
      const id = `TICKET-REVIEW-${reviewDigest({ job_key: job.job_key, finding_id: findingId }).slice(7)}`;
      await locked(async () => {
        if ((await queueStore.list("review.backlog")).some((item) => item.id === id)) return;
        await queueStore.save("review.backlog", { id, task_id: id, source_task_id: job.task_id, job_key: job.job_key, finding_id: findingId,
          status: "planned", owner: "sprint_leader", finding, priority: String(finding.severity).toLowerCase() === "blocker" ? "critical" : String(finding.severity).toLowerCase() === "minor" ? "low" : "high",
          ticket: { id, project_id: job.project_id, title: `Review follow-up: ${job.payload.ticket.title ?? job.task_id}`, objective: finding.failure ?? finding.message ?? String(finding),
            acceptance_criteria: [finding.acceptance_criterion ?? "Independently verify and resolve the retained review finding."], status: "planned", source_task_id: job.task_id },
          decision_identity: job.decision_identity, created_at: new Date().toISOString() });
      });
    }
  }
  if (job.review_result.payload.owner_decision_reason) await eventBus.publish({ type: "review.owner_decision_required", event_id: `EVT-OWNER-${job.request_id}`, task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt, payload: { job_key: job.job_key, reason: job.review_result.payload.owner_decision_reason, findings: job.review_result.payload.findings } });
  const commonReviewFields = { phase: "review", request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, review_gate: job.review_policy.gate, changed_paths: job.payload?.changed_paths ?? [], base_commit: job.payload?.base_commit ?? null, commit: job.payload?.commit ?? null, verification: job.payload?.verification ?? null, execution_context: job.payload?.execution_context ?? null };
  if (job.review_result.payload.verdict) {
    await checkpoints?.completeReview?.(job.task_id, { ...commonReviewFields, ...job.review_result.payload, verification: job.payload.verification, review_attempt: await repairCount(job.task_id), last_error: null });
  } else if (job.review_result.payload.error || job.review_result.type === "review.skipped") {
    await checkpoints?.saveReview?.({ task_id: job.task_id, ...commonReviewFields, status: job.review_result.type === "review.skipped" ? "completed" : "failed", verdict: null, review_attempt: Math.max(await repairCount(job.task_id), job.outcomes?.length ?? 1), last_error: job.review_result.payload.error ?? null });
  }
  await eventBus.publish({ type: job.review_result.type, event_id: job.event_id, task_id: job.task_id, project_id: job.project_id,
    supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt,
    payload: { ...job.review_result.payload, job_key: job.job_key, decision_identity: job.decision_identity, automatic_review: true, review_gate: job.review_policy.gate, inline_review: job.inline_review } });
  await queue.ack(job.id);
}
