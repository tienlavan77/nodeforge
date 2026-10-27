// Reconciles a parked checkpoint with its durable recovery job so explicit RUN does not mistake an interrupted handoff for an Owner decision.
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";

// Includes queued projections that may outlive their job reservation after cancellation or authority validation failure.
export const BLOCKER_RESUME_STATUSES = Object.freeze(["cancelled", "reconciliation_required", "pending", "invoking", "resume_pending",
  "dispatching", "notification_pending", "notifying", "approval_retry_pending"]);

// Repairs only the status projection of the same unlaunched execution and failure; it grants no decision, source waiver or provider replay.
export async function reconcileBlockerResumeCheckpoint({ store, checkpoints, ticketStatusStore, projectId, ticketId }) {
  return store.withLock("blocker.recovery", async () => {
    const checkpoint = await checkpoints.load(ticketId);
    const current = ticketStatusStore.get(ticketId);
    const projection = checkpoint?.blocker_recovery;
    if (current?.project_id !== projectId || current.details?.launch_claim || checkpoint?.status !== "blocked"
      || !BLOCKER_RESUME_STATUSES.includes(projection?.status)) return checkpoint;
    const ledger = (await store.list("blocker.recovery")).find((entry) => entry.project_id === projectId
      && entry.task_id === ticketId && entry.execution_id === current.details.execution_id);
    const job = ledger?.jobs.find((entry) => entry.id === projection.job_id);
    if (!job || !["cancelled", "reconciliation_required"].includes(job.status) || job.status === projection.status
      || checkpoint.failure?.at !== job.failure_at
      || !matchesTicketExecution(current, job.request.payload.execution_id, job.request.payload.sprint_basis)) return checkpoint;
    return checkpoints.save({ ...checkpoint, phase: job.status === "cancelled" ? "blocker_triage_cancelled" : "blocker_reconciliation_required",
      blocker_recovery: { ...projection, status: job.status, reason: job.outcome_reason ?? projection.reason } });
  });
}
