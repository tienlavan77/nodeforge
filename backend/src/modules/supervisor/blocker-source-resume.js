// Returns stale source/dependency waits to SL when Node can now prove inherited Sprint evidence.
import { createHash } from "node:crypto";
import { buildBlockerTicketProgress } from "./blocker-ticket-progress.js";
import { isBlockerSourceRetry } from "./blocker-source-retry.js";

// Refreshes only changed authoritative source receipts without replaying Coder or granting approval.
export function createBlockerSourceResume({ inspect, sprintRegistry, ticketStatusStore, clock = Date.now, projectLogger = () => {} }) {
  const polls = new Map();
  return async (job) => {
    if (isBlockerSourceRetry(job)) {
      let authority;
      try { authority = await inspect(job); }
      catch (error) {
        projectLogger({ event_name: "supervisor.blocker_source_retry_invalid", level: "warn", status: "blocked", task_id: job.request.task_id,
          message: "Retained source retry cannot dispatch under current execution authority.", payload: { job_id: job.id, code: error.code, error: error.message } });
        return false;
      }
      if (!authority?.workspace.root_only) return false;
      job.ticket_progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore });
      job.history.push({ stage: "coder", event: "source_retry_preparation_refreshed", completed_at: clock(), previous_feedback: job.validation_feedback });
      job.source_retry_policy = "agent-source-retry-v1";
      delete job.validation_feedback;
      projectLogger({ event_name: "supervisor.blocker_source_retry_ready", level: "info", status: "pending", task_id: job.request.task_id,
        message: "Retained SL decision returns directly to Coder from its checkpoint with current source context; no agent decision replayed.", payload: { job_id: job.id } });
      return true;
    }
    const sourceChanged = ["TICKET_SOURCE_CHANGED", "TICKET_SOURCE_DRIFT"].includes(job.outcome_reason);
    if (sourceChanged && job.source_resume_policy !== "agent-source-review-v1") {
      const authority = await inspect(job);
      if (!authority?.workspace.root_only || !authority.workspace.changeLedger?.observe) return false;
      const progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore });
      job.history.push({ stage: "sprint_leader", event: "source_changes_assigned_to_agent", completed_at: clock(),
        previous_resolution: job.resolution, previous_feedback: job.validation_feedback });
      job.ticket_progress = progress;
      job.source_resume_policy = "agent-source-review-v1";
      delete job.validation_feedback;
      delete job.resolution;
      projectLogger({ event_name: "supervisor.blocker_source_ready", level: "info", status: "pending", task_id: job.request.task_id,
        message: "Source changes returned to Sprint Leader for retained Coder continuation; settled Architecture decisions preserved.", payload: { job_id: job.id, source_changes: progress.source_changes } });
      return true;
    }
    if (job.outcome_reason !== "technical_reconciliation_waiting_for_evidence"
      || !["source_revision", "dependency"].includes(job.resolution?.reconciliation?.kind)) return false;
    const now = clock();
    if (polls.has(job.id) && now - polls.get(job.id) < 30_000) return false;
    polls.set(job.id, now);
    const authority = await inspect(job);
    if (!authority) return false;
    const progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore });
    const receipts = (value) => [value?.contract_source ?? [], value?.dependencies ?? null, value?.source_reconciliation ?? null];
    const digest = (value) => createHash("sha256").update(JSON.stringify(receipts(value))).digest("hex");
    const identity = digest(progress);
    if (!progress.contract_source.every((entry) => entry.status === "validated")
      || progress.dependencies.status !== "validated" || identity === digest(job.ticket_progress) || identity === job.source_wait_digest) return false;
    job.source_wait_digest = identity;
    job.history.push({ stage: "sprint_leader", event: "inherited_source_evidence_refreshed", completed_at: now, previous_resolution: job.resolution });
    job.ticket_progress = progress;
    delete job.validation_feedback;
    delete job.resolution;
    projectLogger({ event_name: "supervisor.blocker_source_ready", level: "info", status: "success", task_id: job.request.task_id,
      message: "Inherited Sprint source and accepted dependencies verified; returning fresh evidence to Sprint Leader at the retained checkpoint.", payload: { job_id: job.id } });
    return true;
  };
}
