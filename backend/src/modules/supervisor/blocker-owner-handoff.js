// Routes persisted owner direction choices back to AM before any further Coder execution.
import { blockerOwnerDecisions } from "./blocker-owner-decisions.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";

// Restores legacy owner-decided checkpoints from the original ledger and queues a fenced AM fulfillment.
export function createBlockerOwnerHandoff({ store, recovery, checkpoints, ticketStatusStore, inspect, projectLogger }) {
  return fulfillOwnerDecision;

  // Keeps RUN/restart idempotent and retains the exact blocked source rather than beginning another Coder execution.
  async function fulfillOwnerDecision({ projectId, ticketId }) {
    let current = ticketStatusStore.get(ticketId);
    let checkpoint = await checkpoints.load(ticketId);
    const decisions = blockerOwnerDecisions(checkpoint, current);
    const decision = decisions.at(-1);
    const parked = checkpoint?.blocker_recovery;
    if (!decision || !parked || !["blocked", "in_progress"].includes(checkpoint.status)
      || checkpoint.status === "in_progress" && checkpoint.phase !== "owner_decided"
      || current?.project_id !== projectId || current.details?.launch_claim
      || !["needs_human_review", "pending"].includes(current.status)) throw handoffError("No parked owner choice is available for AM fulfillment.");
    const ledger = (await store.list("blocker.recovery")).find((entry) => entry.project_id === projectId && entry.task_id === ticketId && entry.execution_id === current.details?.execution_id);
    const original = ledger?.jobs.find((entry) => entry.id === parked?.job_id);
    if (!original || ledger.cancelled || !matchesTicketExecution(current, original.request.payload.execution_id, original.request.payload.sprint_basis)) throw handoffError("The owner handoff ledger no longer matches this execution.");
    if (parked.status === "governance_required") return { ticket_id: ticketId, status: "needs_human_review", reason: "contract_revision_required", governance_handoff: parked.governance_handoff, job_id: original.id };
    if (current.status === "pending") {
      ticketStatusStore.updateStatus(ticketId, "needs_human_review", { ...current.details, reason: "owner_contract_fulfillment" },
        { expectedVersion: current.version, expectedExecutionId: current.details.execution_id });
      current = ticketStatusStore.get(ticketId);
    }
    // Older decision writers erased the failure; recover only its identity from the matching Node ledger.
    if (checkpoint.status !== "blocked" || !checkpoint.failure) {
      checkpoint = { ...checkpoint, status: "blocked", failure: { code: "CODER_BLOCKED", at: original.failure_at, message: original.message } };
      await checkpoints.save(checkpoint);
    }
    if (!await inspect(original)) throw handoffError("Source or approval identity changed before owner handoff; reconcile the recorded execution.");
    const job = await recovery.followOwnerDecision({ projectId, taskId: ticketId, executionId: current.details.execution_id, jobId: original.id, decision });
    if (!job) throw handoffError("The owner handoff cannot replay a cancelled, active or replaced investigation.");
    if (!["pending", "invoking", "notification_pending", "notifying"].includes(job.status)) throw handoffError("The AM fulfillment has already ended; inspect its governance or reconciliation receipt.");
    const latest = await checkpoints.load(ticketId);
    if (latest.blocker_recovery?.status !== "governance_required") await checkpoints.save({ ...latest, status: "blocked", phase: "blocker_triage_pending", blocker_owner_decisions: decisions,
      blocker_recovery: { ...latest.blocker_recovery, job_id: job.id, status: "pending", stage: "architecture_manager", owner_decision: decision } });
    projectLogger({ event_name: "ticket.blocker_owner_handoff", level: "info", status: "started", task_id: ticketId,
      message: "Owner direction queued for Architecture contract fulfillment; Coder remains parked.", payload: { job_id: job.id, decision_id: decision.decision_id } });
    return { ticket_id: ticketId, execution_id: current.details.execution_id, status: "accepted", pipeline: "supervisor", resumed_stage: "architecture_manager", job_id: job.id };
  }
}

// Exposes stale or incomplete handoffs without converting them into another owner policy proposal.
function handoffError(message) { return Object.assign(new Error(message), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 }); }
