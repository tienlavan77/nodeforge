// Keeps unavailable execution approval services on a timed checkpoint retry instead of Architecture escalation.
import { createBlockerFailureEvidence } from "./blocker-failure-evidence.js";

const INTERVAL_MS = 30_000;

// Distinguishes an approval service failing to return a verdict from an actual policy rejection.
export function approvalServiceUnavailable(receipt) {
  const message = receipt?.error?.message;
  return typeof message === "string" && /(?:^|\n)(?:Reason:\s*)?Automatic approval review failed:\s*unexpected status 503\b/i.test(message);
}

// Arms only known failed service calls, retaining the original denial and any substantive owner decision.
export function scheduleApprovalRetry(job, retry, now) {
  if (!retry || job.approval_retry || !["pending", "notification_pending", "reconciliation_required"].includes(job.status)
    || ["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(job.outcome_reason)
    || job.execution_admission?.decision?.verdict === "deny") return false;
  job.history.push({ stage: job.stage, event: "approval_service_retry_scheduled", previous_status: job.status,
    previous_outcome_reason: job.outcome_reason ?? null, completed_at: now });
  job.approval_retry = retry;
  job.status = "approval_retry_pending";
  job.stage = "coder";
  job.outcome_reason = "APPROVAL_SERVICE_UNAVAILABLE";
  return true;
}

// Captures service-failure receipts and publishes a durable, stoppable retry notice for the retained execution.
export function createBlockerApprovalRetry({ inspect, checkpoints, eventBus, projectLogger, clock = Date.now,
  readFailureEvidence = createBlockerFailureEvidence({ toolNames: null, requirePath: false }) }) {
  return Object.freeze({ prepare, notify });

  // Requires complete failed-operation evidence before treating a reported access blocker as temporary unavailability.
  async function prepare(input) {
    if (input.reason_code !== "ACCESS_REQUIRED") return input;
    const authority = await inspect(input);
    if (!authority) return input;
    const evidence = await readFailureEvidence(input, authority.workspace.projectRoot ?? authority.workspace.path);
    const receipts = evidence.receipts.filter((entry) => /rejected due to unacceptable risk|automatic approval review failed|approval.*denied/i.test(entry.error?.message ?? ""));
    if (evidence.status !== "captured" || !receipts.length || !receipts.every(approvalServiceUnavailable)) return input;
    return { ...input, approval_retry: { reason_code: "APPROVAL_SERVICE_UNAVAILABLE", interval_ms: INTERVAL_MS,
      available_at: clock() + INTERVAL_MS, receipts } };
  }

  // Exposes the next attempt and Stop action without marking the unavailable service as an approval.
  async function notify(job, { force = false } = {}) {
    if (job?.status !== "approval_retry_pending") return;
    const authority = await inspect(job);
    if (!authority || !force && authority.checkpoint.blocker_recovery?.approval_retry?.available_at === job.approval_retry.available_at
      && authority.checkpoint.blocker_recovery?.job_id === job.id) return;
    const message = "Dịch vụ duyệt tạm thời lỗi 503. Node sẽ tự retry mỗi 30 giây từ checkpoint; nhấn Stop nếu muốn tạm dừng.";
    await checkpoints.save({ ...authority.checkpoint, phase: "approval_retry_pending", blocker_recovery: {
      ...(authority.checkpoint.blocker_recovery ?? {}), job_id: job.id, status: "approval_retry_pending", stage: "coder",
      reason: "APPROVAL_SERVICE_UNAVAILABLE", approval_retry: job.approval_retry,
      execution_admission: job.execution_admission ?? null, history: job.history } });
    const request = job.request;
    await eventBus.publish({ type: "task.blocker.reconciliation_required", event_id: `APPROVAL-RETRY-${job.id}`,
      task_id: request.task_id, project_id: request.project_id, supervisor_id: request.supervisor_id,
      request_id: request.request_id, correlation_id: request.correlation_id, attempt: 1,
      payload: { job_id: job.id, reason: "APPROVAL_SERVICE_UNAVAILABLE", message, approval_retry: job.approval_retry,
        execution_id: request.payload.execution_id, execution_basis: request.payload.sprint_basis } });
    projectLogger({ event_name: "supervisor.approval_retry_scheduled", level: "warn", status: "pending", message,
      task_id: request.task_id, correlation_id: request.correlation_id, error_code: "APPROVAL_SERVICE_UNAVAILABLE",
      payload: { job_id: job.id, agent_id: authority.checkpoint.agent_id, retry_after_ms: INTERVAL_MS,
        available_at: job.approval_retry.available_at, receipts: job.approval_retry.receipts } });
  }
}
