// Records an explicit project-owner decision on an AM blocker escalation proposal.
import { blockerOwnerDecisions } from "../modules/supervisor/blocker-owner-decisions.js";
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Persists the owner's chosen option beside the AM proposal without forging approval authority.
export function createTicketBlockerDecisionService({ projectId, ticketStatusStore, checkpoints, publisher, fulfillOwnerDecision, respondOwnerInput, projectLogger = () => {} } = {}) {
  if (!projectId || !ticketStatusStore?.get || !ticketStatusStore?.updateStatus || !checkpoints?.load || !checkpoints?.save) throw new ConfigurationError("Ticket Blocker Decision requires status and checkpoint services.");
  return Object.freeze({ decide, respond: respondOwnerInput });

  // Records the chosen direction and queues AM fulfillment while retaining the blocked Coder checkpoint.
  async function decide({ requestedProjectId, ticketId, actor, reason, optionId }) {
    if (requestedProjectId !== projectId) throw decisionError("PROJECT_CONTEXT_CONFLICT", "Ticket belongs to a different project.", 409);
    const current = ticketStatusStore.get(ticketId);
    if (!current || current.project_id !== projectId) throw decisionError("TICKET_NOT_FOUND", `Ticket not found: ${ticketId}.`, 404);
    const checkpoint = await checkpoints.load(ticketId);
    const recovery = checkpoint?.blocker_recovery;
    if (recovery?.owner_decision) throw decisionError("BLOCKER_DECISION_RECORDED", "An owner decision was already recorded for this blocker.", 409);
    if (current.status !== "needs_human_review" || checkpoint?.status !== "blocked" || recovery?.status !== "owner_required" || !recovery?.proposal) {
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
    const nextCheckpoint = { ...checkpoint, blocker_owner_decisions: [...blockerOwnerDecisions(checkpoint, current), decision], status: "blocked", phase: "owner_decided",
      blocker_recovery: { ...recovery, status: "owner_decided", owner_decision: decision },
      stage_progress: [...priorProgress, { stage: "owner_decision", status: "decided", job_id: recovery.job_id ?? null, option_id: option.id, at: decision.decided_at }] };
    await checkpoints.save(nextCheckpoint);
    const updated = ticketStatusStore.updateStatus(ticketId, "needs_human_review", { ...current.details, reason: "owner_blocker_decision", owner_decision: decision,
      blocker_decision: { decision_id: decision.decision_id, option_id: decision.option_id, job_id: decision.job_id } },
      { expectedCurrentStatus: "needs_human_review", expectedVersion: current.version, expectedExecutionId: current.details?.execution_id });
    try {
      await publisher?.publish?.({ event_id: `EVT-${randomUUID()}`, type: "ticket.updated", project_id: projectId, timestamp: decision.decided_at,
        payload: { ticket_id: ticketId, decision_id: decision.decision_id, option_id: decision.option_id, job_id: decision.job_id, reason: decision.reason } });
    } catch (error) {
      projectLogger({ event_name: "ticket.blocker_decision_publish_failed", level: "error", status: "failed", message: "Owner blocker decision was saved but the UI refresh event failed.", task_id: ticketId, source: "ticket-blocker-decision-service", error_code: error.code ?? "EVENT_PUBLISH_FAILED", payload: { error: error.message } });
    }
    projectLogger({ event_name: "ticket.blocker_owner_decision_recorded", level: "info", status: "success", message: "Project owner decided the AM blocker escalation proposal.", task_id: ticketId, source: "ticket-blocker-decision-service", payload: { decision_id: decision.decision_id, option_id: decision.option_id, job_id: decision.job_id } });
    let handoff;
    try { handoff = await fulfillOwnerDecision?.({ projectId, ticketId }); }
    catch (error) { projectLogger({ event_name: "ticket.blocker_owner_handoff_deferred", level: "error", status: "blocked", task_id: ticketId,
      message: "Owner choice is saved; AM handoff requires reconciliation. Coder remains parked.", payload: { code: error.code, error: error.message } }); }
    return { ticket_id: ticketId, status: updated.status, decision, ...(handoff ? { handoff } : {}) };
  }
}

// Returns a stable API error for blocker decision requests.
function decisionError(code, message, statusCode) { return Object.assign(new ConfigurationError(message), { code, statusCode }); }
