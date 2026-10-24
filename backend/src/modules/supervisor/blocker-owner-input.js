/** Delivers technical questions to the authenticated Owner and returns their
 * source-bound answers to SL at the retained Coder checkpoint after restart. */
import { randomUUID } from "node:crypto";
import { blockerOwnerRequest } from "./blocker-owner-request.js";

/** Uses the recovery ledger lock to serialize answers with Stop and worker
 * transitions; checkpoint-first persistence allows a queued reply to survive a crash. */
export function createBlockerOwnerInput({ store, checkpoints, ticketStatusStore, inspect, eventBus, projectLogger, clock = Date.now }) {
  return Object.freeze({ getOwnerRequest, respondOwnerInput, refreshOwnerInput });

  /** Reads the retained agent guidance for legacy checkpoints so the full
   * disclosed question is visible without mutating or migrating the ticket. */
  async function getOwnerRequest({ projectId, ticketId }) {
    const current = ticketStatusStore.get(ticketId);
    if (current?.project_id !== projectId) return null;
    const checkpoint = await checkpoints.load(ticketId);
    const ledger = (await store.list("blocker.recovery")).find((entry) => entry.project_id === projectId
      && entry.task_id === ticketId && entry.execution_id === current.details?.execution_id);
    const job = ledger?.jobs.find((entry) => entry.id === checkpoint?.blocker_recovery?.job_id);
    return job && !ledger.cancelled ? requestFor(job, checkpoint, current) : null;
  }

  /** Records an authenticated answer to the exact displayed request. It does
   * not clear a denial, change approval, mutate source, or launch Coder. */
  async function respondOwnerInput({ requestedProjectId, ticketId, actor, jobId, executionId, requestId, answer }) {
    if (typeof actor !== "string" || !actor.trim() || typeof answer !== "string" || !answer.trim() || answer.length > 8000)
      throw inputError("BLOCKER_OWNER_INPUT_INVALID", "Provide an authenticated Owner and a nonempty answer within 8000 characters.", 400);
    const result = await store.withLock("blocker.recovery", async () => {
      const current = ticketStatusStore.get(ticketId);
      if (current?.project_id !== requestedProjectId) throw inputError("PROJECT_CONTEXT_CONFLICT", "Ticket belongs to a different project.");
      if (!executionId || current.details?.execution_id !== executionId) throw inputError("BLOCKER_OWNER_INPUT_STALE", "The ticket execution changed; reload the question.");
      const checkpoint = await checkpoints.load(ticketId);
      const ledger = (await store.list("blocker.recovery")).find((entry) => entry.project_id === requestedProjectId
        && entry.task_id === ticketId && entry.execution_id === executionId);
      const job = ledger?.jobs.find((entry) => entry.id === jobId);
      if (!job || ledger.cancelled || current.details?.launch_claim || current.details?.reason === "TICKET_STOPPED")
        throw inputError("BLOCKER_OWNER_INPUT_UNAVAILABLE", "The recovery is stopped, active or replaced.");
      const prior = checkpoint.blocker_owner_inputs?.find((entry) => entry.request_id === requestId && entry.job_id === jobId && entry.execution_id === executionId);
      if (prior) {
        if (prior.answer !== answer.trim() || prior.actor !== actor) throw inputError("BLOCKER_OWNER_INPUT_RECORDED", "This question already has a different Owner response.");
        return { receipt: prior, duplicate: true, request: job.request };
      }
      const request = requestFor(job, checkpoint, current);
      if (current.status !== "needs_human_review" || checkpoint.status !== "blocked" || job.status !== "reconciliation_required"
        || !request || request.request_id !== requestId || !await inspect(job))
        throw inputError("BLOCKER_OWNER_INPUT_STALE", "No matching external question is awaiting an answer; reload the ticket.");
      const receipt = { input_id: `BLOCKER-INPUT-${randomUUID()}`, project_id: requestedProjectId, ticket_id: ticketId,
        execution_id: executionId, job_id: jobId, request_id: requestId, actor, answer: answer.trim(), request, received_at: clock() };
      await checkpoints.save({ ...checkpoint, blocker_owner_inputs: [...(checkpoint.blocker_owner_inputs ?? []), receipt],
        blocker_recovery: { ...checkpoint.blocker_recovery, owner_response: receipt } });
      return { receipt, duplicate: false, request: job.request };
    });
    projectLogger({ event_name: "ticket.blocker_owner_input_recorded", level: "info", status: "success", task_id: ticketId,
      message: "Owner response recorded; SL will continue from the retained checkpoint. Tool authorization remains enforced.",
      payload: { input_id: result.receipt.input_id, job_id: jobId, request_id: requestId, duplicate: result.duplicate } });
    try { await eventBus.publish({ type: "ticket.updated", event_id: `OWNER-INPUT-${result.receipt.input_id}`, project_id: requestedProjectId,
      task_id: ticketId, supervisor_id: result.request.supervisor_id, request_id: result.request.request_id,
      correlation_id: result.request.correlation_id, attempt: 1, payload: { ticket_id: ticketId, reason: "blocker_owner_input_recorded" } }); }
    catch (error) { projectLogger({ event_name: "ticket.blocker_owner_input_publish_failed", level: "error", status: "failed", task_id: ticketId, message: error.message }); }
    return { ticket_id: ticketId, status: "recorded", receipt: result.receipt, handoff: { status: "queued", resumed_stage: "sprint_leader" } };
  }

  /** Consumes each durable answer once inside the existing worker lock. Only
   * SL is rearmed; its next validated disposition determines the Coder handoff. */
  async function refreshOwnerInput(job) {
    if (job.status !== "reconciliation_required") return false;
    const waiting = job.resolution?.reconciliation?.waiting_for ?? job.technical_reconciliation?.work?.waiting_for;
    if (!waiting?.some((entry) => entry?.owner === "external")) return false;
    const saved = await checkpoints.load(job.request.task_id);
    if (!saved?.blocker_owner_inputs?.some((entry) => entry.job_id === job.id && entry.execution_id === job.request.payload.execution_id
      && !job.owner_inputs?.some((prior) => prior.input_id === entry.input_id))) return false;
    const authority = await inspect(job);
    if (!authority) return false;
    const request = requestFor(job, authority.checkpoint, authority.current);
    if (!request) return false;
    const receipts = (authority.checkpoint.blocker_owner_inputs ?? []).filter((entry) => entry.job_id === job.id
      && entry.execution_id === job.request.payload.execution_id && entry.request_id === request.request_id);
    const fresh = receipts.filter((entry) => !job.owner_inputs?.some((prior) => prior.input_id === entry.input_id));
    if (!fresh.length) return false;
    job.owner_inputs = [...(job.owner_inputs ?? []), ...fresh];
    job.history.push({ stage: "sprint_leader", event: "owner_input_received", input_ids: fresh.map((entry) => entry.input_id),
      previous_resolution: job.resolution, completed_at: clock() });
    job.coordination_feedback = "Consume the Node-recorded Owner answer and coordinate the remaining work from the retained Coder checkpoint. This answer is not a tool authorization receipt; actual permission checks still run. Do not repeat an answered request.";
    delete job.resolution; delete job.validation_feedback;
    projectLogger({ event_name: "ticket.blocker_owner_input_delivered", level: "info", status: "pending", task_id: job.request.task_id,
      message: "Owner response delivered to Sprint Leader; original Coder checkpoint and tool controls preserved.", payload: { job_id: job.id, input_ids: fresh.map((entry) => entry.input_id) } });
    return true;
  }
}

/** Binds both modern typed requests and legacy explicit external waits to the
 * same exact question, guidance, execution and recovery job displayed in the UI. */
function requestFor(job, checkpoint, current) {
  const recovery = checkpoint?.blocker_recovery;
  if (recovery?.job_id !== job.id) return null;
  return blockerOwnerRequest({ ...recovery, guidance: recovery.guidance ?? job.resolution?.guidance,
    owner_request: recovery.owner_request ?? job.resolution?.reconciliation?.owner_request,
    waiting_for: recovery.waiting_for ?? job.resolution?.reconciliation?.waiting_for }, current.details?.execution_id);
}

/** Exposes actionable conflicts without treating an Owner response as approval. */
function inputError(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode }); }
