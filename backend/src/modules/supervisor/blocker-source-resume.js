// Returns stale source/dependency waits to SL when Node can now prove inherited Sprint evidence.
import { createHash } from "node:crypto";
import { buildBlockerTicketProgress } from "./blocker-ticket-progress.js";

// Refreshes only changed authoritative source receipts without replaying Coder or granting approval.
export function createBlockerSourceResume({ inspect, sprintRegistry, ticketStatusStore, clock = Date.now, projectLogger = () => {} }) {
  const polls = new Map();
  return async (job) => {
    if (job.outcome_reason !== "technical_reconciliation_waiting_for_evidence"
      || !["source_revision", "dependency"].includes(job.resolution?.reconciliation?.kind)) return false;
    const now = clock();
    if (polls.has(job.id) && now - polls.get(job.id) < 30_000) return false;
    polls.set(job.id, now);
    const authority = await inspect(job);
    if (!authority) return false;
    const progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore });
    const receipts = (value) => [value?.contract_source ?? [], value?.dependencies ?? null];
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
