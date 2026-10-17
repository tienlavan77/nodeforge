// Records an explicit project-owner decision on an AM blocker escalation proposal.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Persists the owner's chosen option beside the AM proposal without forging approval authority.
export function createTicketBlockerDecisionService({ projectId, ticketStatusStore, checkpoints, publisher, projectLogger = () => {} } = {}) {
  if (!projectId || !ticketStatusStore?.get || !ticketStatusStore?.updateStatus || !checkpoints?.load || !checkpoints?.save) throw new ConfigurationError("Ticket Blocker Decision requires status and checkpoint services.");
  return Object.freeze({ decide });

  // Records one durable decision on the published owner_required proposal and returns the ticket to pending.
  async function decide({ requestedProjectId, ticketId, actor, reason, optionId }) {
    if (requestedProjectId !== projectId) throw decisionError("PROJECT_CONTEXT_CONFLICT", "Ticket belongs to a different project.", 409);
    const current = ticketStatusStore.get(ticketId);
    if (!current || current.project_id !== projectId) throw decisionError("TICKET_NOT_FOUND", `Ticket not found: ${ticketId}.`, 404);
    const checkpoint = await checkpoints.load(ticketId);
    const recovery = checkpoint?.blocker_recovery;
    if (recovery?.owner_decision) throw decisionError("BLOCKER_DECISION_RECORDED", "An owner decision was already recorded for this blocker.", 409);
    if (checkpoint?.status !== "blocked" || recovery?.status !== "owner_required" || !recovery?.proposal) {
      throw decisionError("BLOCKER_DECISION_UNAVAILABLE", "Ticket has no owner decision proposal awaiting a choice.", 409);
    }
    if (typeof actor !== "string" || !actor.trim()) throw decisionError("BLOCKER_DECISION_INPUT", "Actor is required.", 400);
    if (typeof optionId !== "string" || !optionId.trim()) throw decisionError("BLOCKER_DECISION_INPUT", "A proposal option id is required.", 400);
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 8000)) throw decisionError("BLOCKER_DECISION_INPUT", "Reason must be text within 8000 characters.", 400);
    const option = recovery.proposal.options?.find((entry) => entry?.id === optionId);
    if (!option) throw decisionError("BLOCKER_DECISION_OPTION_INVALID", `Unknown proposal option: ${optionId}.`, 400);
    const decision = { decision_id: `BLOCKER-DECISION-${randomUUID()}`, actor: actor.trim(), option_id: option.id, option_description: option.description ?? null,
      reason: reason?.trim() || null, job_id: recovery.job_id ?? null, proposal_title: recovery.proposal.title ?? null,
      escalation: recovery.escalation ?? null, decided_at: new Date().toISOString() };
    const priorProgress = Array.isArray(checkpoint.stage_progress) ? checkpoint.stage_progress : [];
    const nextCheckpoint = { ...checkpoint, status: "in_progress", phase: "owner_decided",
      blocker_recovery: { ...recovery, status: "owner_decided", owner_decision: decision },
      stage_progress: [...priorProgress, { stage: "owner_decision", status: "decided", job_id: recovery.job_id ?? null, option_id: option.id, at: decision.decided_at }] };
    delete nextCheckpoint.failure;
    await checkpoints.save(nextCheckpoint);
    const updated = ticketStatusStore.updateStatus(ticketId, "pending", { ...current.details, reason: "owner_blocker_decision", owner_decision: decision,
      blocker_decision: { decision_id: decision.decision_id, option_id: decision.option_id, job_id: decision.job_id } },
      { expectedCurrentStatus: "needs_human_review", expectedVersion: current.version });
    try {
      await publisher?.publish?.({ event_id: `EVT-${randomUUID()}`, type: "ticket.updated", project_id: projectId, timestamp: decision.decided_at,
        payload: { ticket_id: ticketId, decision_id: decision.decision_id, option_id: decision.option_id, job_id: decision.job_id, reason: decision.reason } });
    } catch (error) {
      projectLogger({ event_name: "ticket.blocker_decision_publish_failed", level: "error", status: "failed", message: "Owner blocker decision was saved but the UI refresh event failed.", task_id: ticketId, source: "ticket-blocker-decision-service", error_code: error.code ?? "EVENT_PUBLISH_FAILED", payload: { error: error.message } });
    }
    projectLogger({ event_name: "ticket.blocker_owner_decision_recorded", level: "info", status: "success", message: "Project owner decided the AM blocker escalation proposal.", task_id: ticketId, source: "ticket-blocker-decision-service", payload: { decision_id: decision.decision_id, option_id: decision.option_id, job_id: decision.job_id } });
    return { ticket_id: ticketId, status: updated.status, decision };
  }
}

// Returns a stable API error for blocker decision requests.
function decisionError(code, message, statusCode) { return Object.assign(new ConfigurationError(message), { code, statusCode }); }
