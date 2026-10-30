/** Describes the review phase for technical recovery without changing ticket
 * execution, finding state or independent Reviewer authority. Missing current
 * checkpoints never erase durable findings, repair cycles or earlier review
 * progress, and unavailable evidence is distinguished from a review not begun. */

/** Combines Node-held review records and repair markers into a factual handoff
 * for SL and AM. This projection does not approve a revision, close a finding,
 * dispatch Reviewer or treat an agent's narrative as evidence of a review. */
export function blockerReviewStatus({ job, checkpoint = {}, context, reviewCheckpoint, reviewExchange, retainedReviewSource }) {
  const taskId = job.request.task_id, projectId = job.request.project_id;
  const sources = [], unavailable = [];
  const validReview = reviewCheckpoint && (reviewCheckpoint.task_id === undefined || reviewCheckpoint.task_id === taskId)
    && (reviewCheckpoint.project_id === undefined || reviewCheckpoint.project_id === projectId)
    && (reviewCheckpoint.execution_context?.task_id === undefined || reviewCheckpoint.execution_context.task_id === taskId)
    && (reviewCheckpoint.execution_context?.project_id === undefined || reviewCheckpoint.execution_context.project_id === projectId);
  const validHistory = reviewExchange && (reviewExchange.task_id === undefined || reviewExchange.task_id === taskId)
    && (reviewExchange.project_id === undefined || reviewExchange.project_id === projectId);
  if (reviewCheckpoint === undefined || reviewCheckpoint && !validReview) unavailable.push("review_checkpoint");
  if (reviewExchange === undefined || reviewExchange && !validHistory) unavailable.push("review_history");
  const review = validReview ? reviewCheckpoint : null;
  const history = validHistory ? reviewExchange : null;
  if (review) sources.push("review_checkpoint");
  if (history?.findings?.length) sources.push("review_findings");
  if (history?.adjudications?.length) sources.push("review_adjudications");
  const assigned = [...(checkpoint.review_findings ?? []), ...(job.request.payload?.review_findings ?? [])];
  if (assigned.length) sources.push("assigned_review_findings");
  const cycleId = context?.source_repair_cycle_id ?? context?.review_repair_cycle_id ?? context?.resumed_finding_cycle_id
    ?? checkpoint.review_cycle_id ?? job.request.payload?.review_cycle_id ?? retainedReviewSource?.cycle_id ?? null;
  if (cycleId || checkpoint.review_repair_key || ["review_repair", "finding_repair_preparing", "finding_repair_ready"].includes(checkpoint.phase)) sources.push("review_repair_cycle");
  const stages = (checkpoint.stage_progress ?? []).filter((entry) => ["reviewer", "review"].includes(entry.stage));
  if (stages.length) sources.push("review_stage_history");
  if (checkpoint.review_stage) sources.push("review_stage");
  if (retainedReviewSource) sources.push("retained_review_source");
  const findings = [...(history?.findings ?? []), ...assigned, ...(review?.review_findings ?? []), ...(review?.findings ?? [])];
  const findingIds = [...new Set(findings.map((entry) => entry?.finding_id).filter(Boolean))];
  const verdict = review?.verdict ?? checkpoint.review_stage?.verdict
    ?? stages.findLast((entry) => ["approved", "request_changes"].includes(entry.status))?.status ?? null;
  const active = review?.status === "in_progress" || context?.state === "reviewing";
  const repair = !active && (verdict === "request_changes" || findings.some((entry) => entry?.status === "open")
    || verdict !== "approved" && (assigned.length > 0 || sources.includes("review_repair_cycle")));
  const recorded = sources.length > 0;
  const status = active ? "in_progress" : repair ? "finding_repair" : review?.status ?? (recorded ? "recorded" : unavailable.length ? "unknown" : "not_started");
  const reportStatus = review?.status === "completed" && review.verdict || history?.findings?.length || history?.adjudications?.length
    ? "recorded" : status === "not_started" ? "not_created" : "unknown";
  return { status, phase: active ? "review" : repair ? "finding_repair" : status === "not_started" ? "before_review" : review ? "review" : "unknown",
    verdict, checkpoint_status: review?.status ?? null, report_status: reportStatus, cycle_id: cycleId, repair_key: checkpoint.review_repair_key ?? null,
    finding_ids: findingIds, sources, unavailable_sources: unavailable,
    notice: status === "not_started" ? "No review checkpoint or review history is recorded; no Reviewer report has been created."
      : repair ? "Technical recovery is inside an existing finding repair. Preserve finding IDs, review history and Coder checkpoint; after permitted repair and verification, return to independent Reviewer."
        : status === "unknown" ? "Review evidence is unavailable. Do not infer that review never ran, invent a missing report, or reset the retained execution."
          : "Retained review evidence is preserved. This state does not approve the current source, close findings or grant tool permission." };
}
