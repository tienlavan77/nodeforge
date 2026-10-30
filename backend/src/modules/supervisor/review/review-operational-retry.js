// Retries temporary independent-review outages every 30 seconds without rerunning Coder or accepting unreviewed work.
import { setTimeout as sleep } from "node:timers/promises";
import { assertReviewRequestOwnership } from "../recovery-evidence.js";
import { matchesAutomaticReviewContext } from "./automatic-review-identity.js";

// Keeps retry intent durable across restart and checks Stop and verified source before each read-only invocation.
export async function retryOperationalReview({ job, attempt, retry, load, save, locked, ticketStatusStore, resolveTicketWorkspace,
  checkpoints, eventBus, projectLogger, clock = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }) }) {
  const controller = new AbortController();
  let waitingAgent;
  const unsubscribe = eventBus?.subscribe?.("*", event => {
    if (event.task_id === job.task_id && event.project_id === job.project_id && event.type === "task.failed"
      && event.payload?.reason === "TICKET_STOPPED" && event.payload?.execution_id === job.payload?.execution_id) controller.abort();
  });
  try {
    for (;;) {
      if (!await valid()) return cancel();
      const result = await attempt(job);
      if (!result?.payload?.error?.retryable) {
        await locked(async () => { const fresh = await load(job.id); if (fresh.operational_retry) await save({ ...fresh, operational_retry: { ...fresh.operational_retry, status: "finished" } }); });
        return result;
      }
      const current = await locked(async () => {
        const fresh = await load(job.id);
        if (fresh.operational_retry?.status === "pending") return fresh;
        const operational_retry = { status: "pending", interval_ms: 30_000, available_at: clock() + 30_000,
          attempt_id: fresh.outcomes.at(-1).attempt_id, error: result.payload.error };
        const next = { ...fresh, operational_retry };
        await save(next);
        return next;
      });
      const retryState = current.operational_retry;
      const agentWait = retryState.error.agent_wait;
      const message = agentWait
        ? "Reviewer đang bận ticket khác. Node giữ report/commit/artifact và tự kiểm tra lại sau 30 giây; nhấn Stop để tạm dừng."
        : "Reviewer gặp lỗi kết nối tạm thời. Node sẽ retry sau 30 giây trên cùng commit/artifact; nhấn Stop để tạm dừng.";
      if (!agentWait || waitingAgent !== agentWait.agent_id) {
        projectLogger({ event_name: agentWait ? "review.agent_wait_scheduled" : "review.retry_scheduled", level: agentWait ? "info" : "warn", status: "pending", task_id: job.task_id,
          correlation_id: job.correlation_id, message, error_code: retryState.error.code,
          payload: { retry_after_ms: Math.max(0, retryState.available_at - clock()), available_at: retryState.available_at, job_key: job.job_key, ...(agentWait ? { agent_wait: agentWait } : {}) } });
        if (agentWait) await eventBus?.publish?.({ type: "ticket.updated", task_id: job.task_id, project_id: job.project_id, supervisor_id: job.supervisor_id,
          request_id: job.source_request?.request_id ?? job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1,
          payload: { ticket_id: job.task_id, reason: "REVIEWER_BUSY", message, agent_wait: agentWait, execution_id: job.payload?.execution_id, execution_basis: job.payload?.sprint_basis } });
      }
      waitingAgent = agentWait?.agent_id;
      const prior = await checkpoints?.loadReview?.(job.task_id);
      if (prior) await checkpoints.saveReview({ ...prior, status: agentWait ? "in_progress" : "failed", operational_retry: retryState });
      try { await wait(Math.max(0, retryState.available_at - clock()), controller.signal); }
      catch (error) { if (!controller.signal.aborted) throw error; }
      if (!await valid()) return cancel();
      await retry(current);
      await locked(async () => { const fresh = await load(job.id); await save({ ...fresh, operational_retry: { ...fresh.operational_retry, status: "retrying" } }); });
    }
  } finally { unsubscribe?.(); }

  // Revalidates execution ownership and exact artifact before retry; stale source never becomes new approval.
  async function valid() {
    if (controller.signal.aborted) return false;
    const current = ticketStatusStore?.get?.(job.task_id);
    if (ticketStatusStore && (!current || !(job.review_policy?.gate === "off" ? ["done"] : ["running", "reviewing"]).includes(current.status) || current.details?.reason === "TICKET_STOPPED")) return false;
    assertReviewRequestOwnership(job, ticketStatusStore);
    const workspace = await resolveTicketWorkspace(job.task_id);
    return matchesAutomaticReviewContext(await workspace.executionContexts.load(job.task_id), job);
  }

  // Retains the last failed attempt when Stop or a source transition cancels the scheduled retry.
  async function cancel() {
    await locked(async () => { const fresh = await load(job.id); await save({ ...fresh, operational_retry: { ...fresh.operational_retry, status: "cancelled" } }); });
    const prior = await checkpoints?.loadReview?.(job.task_id);
    if (prior) await checkpoints.saveReview({ ...prior, status: "failed", operational_retry: { ...prior.operational_retry, status: "cancelled" } });
    throw Object.assign(new Error("Reviewer retry stopped or its execution/source changed; checkpoint retained."), { code: "TICKET_STOPPED" });
  }
}

// Restores the original inline completion/repair orchestration after restart instead of orphaning its verdict.
export async function recoverOperationalReview({ job, checkpoints, resumeReview, process, recover }) {
  if (!job.inline_review || !resumeReview) { await process(job); return recover(); }
  const coder = await checkpoints.load(job.task_id);
  if (coder?.status !== "completed" || !coder.agent_id || !coder.provider) throw Object.assign(new Error("Reviewer retry requires the retained completed Coder checkpoint."), { code: "REVIEW_RETRY_CHECKPOINT_INVALID" });
  const request = job.source_request;
  return resumeReview({ ...request, request_id: `REVIEW-RETRY-${job.request_id}-${job.outcomes.length}`,
    payload: { ...request.payload, resume_from: undefined, retry_source_identity: undefined,
      review_resume: { agent_id: coder.agent_id, provider: coder.provider, changed_paths: job.payload.changed_paths,
        base_commit: job.payload.base_commit, verification: job.payload.verification } } });
}
