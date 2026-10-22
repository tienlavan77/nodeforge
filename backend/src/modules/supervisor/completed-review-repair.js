// Hands retained review findings to Coder and the existing blocking review/integration pipeline.
import { currentReviewFindings } from "./review-query-records.js";
import { restoreCompletedReviewFindings } from "./completed-review-findings.js";
import { createHash } from "node:crypto";
import { assertReviewRequestOwnership } from "./recovery-evidence.js";

// Starts one resumable repair cycle from a persisted independent request_changes verdict.
export async function dispatchCompletedReviewRepair({ job, prior, workspace, current, ticketStatusStore, checkpoints, queueStore, resumeRepair, projectLogger }) {
  if (!resumeRepair || !workspace.beginReviewRepair) throw failure("REVIEW_REPAIR_UNAVAILABLE", "Finding-driven repair is unavailable.");
  if (prior?.verdict !== "request_changes" || prior.commit !== job.payload.verification.commit_sha || prior.verification?.artifact_id !== job.payload.verification.artifact_id) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Repair requires the exact persisted review verdict.");
  const findings = await restoreCompletedReviewFindings({ job, prior, workspace, projectLogger });
  if (!findings.length) throw failure("REVIEW_FINDINGS_UNAVAILABLE", "No persisted findings are available for Coder repair.");
  const baseline = job.payload.execution_context.approved_baseline?.file_checksums;
  if (findings.some((entry) => {
    const finding = entry.finding ?? entry;
    return String(finding.severity).toLowerCase() === "blocker" || baseline && (finding.files ?? []).some((path) => !Object.hasOwn(baseline, path));
  })) throw failure("REVIEW_OWNER_DECISION_REQUIRED", "Finding requires a scope or safety decision before Coder repair.");
  const references = currentReviewFindings(findings, await workspace.reviewFindings?.loadQuery?.());
  const cycleId = createHash("sha256").update(`${job.id}:${prior.request_id}`).digest("hex");
  const coder = await checkpoints.load(job.task_id);
  if (coder?.status !== "completed" && coder?.review_cycle_id !== cycleId) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Original completed Coder checkpoint is required.");
  assertReviewRequestOwnership(job, ticketStatusStore);
  const prepared = await workspace.beginReviewRepair({ binding: current.details.review_reopen, cycleId });
  await queueStore.save("review.repair", { id: cycleId, task_id: job.task_id, project_id: job.project_id, source_job_id: job.id, receipt: prepared.receipt, repair_consumed: true });
  const resume = coder.review_cycle_id === cycleId ? coder : { ...coder, status: "in_progress", phase: "review_repair", review_findings: references, review_cycle_id: cycleId,
    failure: null, failure_request_id: null, triage: null, blocker_recovery: null, completed_at: null, review_stage: null,
    attempt: (prior.attempt ?? 1) + 1, session_id: null, thread_id: null, changed_paths: [], completed_tools: [], read_cache: {}, coder_rules_read: false };
  await checkpoints.save(resume);
  const latest = ticketStatusStore.get(job.task_id);
  const updated = ticketStatusStore.updateStatus(job.task_id, "running", { ...latest.details, reason: "review_request_changes",
    review_reopen: { ...latest.details.review_reopen, repair_cycle_id: cycleId, repair_receipt: prepared.receipt } },
  { expectedCurrentStatus: "reviewing", expectedVersion: current.version, expectedExecutionId: current.details.execution_id });
  projectLogger({ event_name: "review.coder_repair_prepared", level: "info", status: "pending", message: "Reviewer findings and checkpoint prepared; Coder dispatch is pending.",
    task_id: job.task_id, source: "completed-review-repair", payload: { findings_count: findings.length, cycle_id: cycleId, resumed_from_turn: coder.last_completed_turn } });
  try { return await resumeRepair({ ticket: job.payload.ticket, task_id: job.task_id, project_id: job.project_id, attempt: resume.attempt,
    request_id: `REVIEW-REPAIR-${cycleId}`, correlation_id: `CORR-REVIEW-REPAIR-${cycleId}`,
    payload: { ...job.source_request.payload, execution_id: updated.details.execution_id, sprint_basis: updated.details.execution_basis,
      dependency_expectations: updated.details.dependency_expectations, review_findings: references, resume_from: resume, review_cycle_id: cycleId } });
  } catch (error) {
    const failed = ticketStatusStore.get(job.task_id);
    if (failed?.status === "running" && failed.details.execution_id === updated.details.execution_id && !failed.details.launch_claim
      && failed.details.review_reopen?.repair_cycle_id === cycleId) {
      try { ticketStatusStore.updateStatus(job.task_id, "failed", { ...failed.details,
      reason: "review_repair_dispatch_failed", error: error.message, failure_code: error.code ?? "REVIEW_REPAIR_DISPATCH_FAILED" },
    { expectedCurrentStatus: "running", expectedVersion: failed.version, expectedExecutionId: updated.details.execution_id }); }
      catch (statusError) {
        error.execution_status_conflict = statusError.message;
        projectLogger({ event_name: "review.repair_status_failed", level: "error", status: "failed", message: statusError.message,
          task_id: job.task_id, source: "completed-review-repair", error_code: statusError.code ?? "REVIEW_REPAIR_STATUS_FAILED" });
      }
    }
    projectLogger({ event_name: "review.coder_repair_dispatch_failed", level: "error", status: "failed", message: error.message,
      task_id: job.task_id, source: "completed-review-repair", error_code: error.code ?? "REVIEW_REPAIR_DISPATCH_FAILED", payload: { cycle_id: cycleId } });
    throw error;
  }
}

// Reports missing authority or evidence without rerunning an already completed Coder ticket.
function failure(code, message) { return Object.assign(new Error(message), { code, statusCode: 409 }); }
