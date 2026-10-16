// Connects bounded Coder recovery to approved dispatch, durable cancellation, and current ticket authority.
import { createCoderOperationalRecovery } from "./coder-operational-recovery.js";
import { coderRecoveryPolicy } from "./coder-recovery-policy.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { assertDependencySubmission } from "./ticket-dependency-expectations.js";
import { assertApprovedTicket } from "../governance/sprint-plan-draft.js";

// Builds real retry adapters while leaving standalone/direct-code requests and human authority unchanged.
export function createCoderRecoveryRuntime({ store, ticketStatusStore, sprintRegistry, resolveTicketWorkspace, checkpoints,
  eventBus, submitTicket, disposition, agentOccupancy, policy = coderRecoveryPolicy(), clock, logger = console } = {}) {
  if (!ticketStatusStore || !sprintRegistry || !resolveTicketWorkspace) return null;
  const active = new Map();
  const recovery = createCoderOperationalRecovery({ store, policy, validateExecution, dispatch, publishTerminal, clock, logger });
  return Object.freeze({ ...recovery, runTicket, stopTicket });

  // Rechecks approved scope, dependency intent, cancellation and exact source before retry reservation and launch.
  async function validateExecution(request) {
    const payload = request.payload ?? {};
    const current = ticketStatusStore.get(request.task_id);
    if (!matchesTicketExecution(current, payload.execution_id, payload.sprint_basis) || current.status !== "running" || current.details.launch_claim) return false;
    if ((await disposition?.get(request.task_id))?.disposition === "cancelled") return false;
    try {
      const { plan } = await sprintRegistry.assertReady(request.ticket.sprint_id, { expectedVersion: payload.sprint_basis.version });
      assertApprovedTicket(plan, request.ticket);
      const workspace = await resolveTicketWorkspace(request.task_id);
      const context = await workspace.executionContexts.load(request.task_id);
      if (!context || context.state === "terminal" || context.project_id !== request.project_id
        || context.source_revision !== request.execution_context?.source_revision
        || context.base_sha !== request.execution_context?.base_sha
        || context.manifest_sha !== request.execution_context?.manifest_sha
        || context.review_commit_sha !== request.execution_context?.review_commit_sha) return false;
      assertDependencySubmission({ projectId: request.project_id, ticket: request.ticket, payload, sprintRegistry, ticketStatusStore });
      return true;
    } catch (error) {
      logger.warn?.("Coder retry authority could not be revalidated.", { task_id: request.task_id, code: error.code ?? "RECOVERY_AUTHORITY_INVALID" });
      return false;
    }
  }

  // Uses the same inline launch-claim boundary for retries from either failure route, never a second provider queue.
  async function dispatch(request) {
    if (!await validateExecution(request)) throw failure("TICKET_STOPPED", "Coder retry authority changed before dispatch.");
    const checkpoint = await checkpoints.load(request.task_id);
    if (!checkpoint || checkpoint.status === "completed") throw failure("CODER_RECOVERY_CHECKPOINT_INVALID", "Coder retry requires unfinished durable work.");
    const resume = { ...checkpoint, status: "in_progress" };
    delete resume.failure;
    try {
      return await runTicket({ ticket: request.ticket, task_id: request.task_id, project_id: request.project_id,
        request_id: request.request_id, correlation_id: request.correlation_id, attempt: request.attempt ?? 1,
        required_role: request.required_role, payload: { ...request.payload, retry_source_identity: request.execution_context, resume_from: resume } });
    } catch (error) {
      const current = ticketStatusStore.get(request.task_id);
      if (current?.details?.launch_claim || ["running", "reviewing"].includes(current?.status)) throw error;
      logger.warn?.("Coder retry ended without completion.", { task_id: request.task_id, code: error.code });
      return { status: "failed" };
    }
  }

  // Tracks initial and retried invocations so Stop interrupts the actual provider rather than only the HTTP request.
  async function runTicket(input) {
    const taskId = input.task_id ?? input.ticket.id;
    if (!input.payload?.execution_id) return submitTicket(input);
    if (active.has(taskId)) throw failure("TICKET_ALREADY_RUNNING", "Ticket already owns a local provider invocation.");
    const controller = new AbortController();
    const abort = () => controller.abort(input.abortSignal.reason);
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) abort();
    active.set(taskId, controller);
    try { return await submitTicket({ ...input, abortSignal: controller.signal }); }
    finally { active.delete(taskId); input.abortSignal?.removeEventListener("abort", abort); }
  }

  // Fences pending dispatch synchronously through the status transaction, then persists the execution cancellation.
  async function stopTicket({ projectId, ticketId }) {
    const current = ticketStatusStore.get(ticketId);
    if (current?.project_id !== projectId || !current.details?.execution_id || !["running", "reviewing"].includes(current.status)) throw failure("TICKET_NOT_RUNNING", "Ticket has no active execution to stop.");
    ticketStatusStore.updateStatus(ticketId, "failed", { ...current.details, reason: "TICKET_STOPPED", error: "Ticket stopped by owner." },
      { expectedVersion: current.version, expectedExecutionId: current.details.execution_id });
    active.get(ticketId)?.abort(failure("TICKET_STOPPED", "Ticket stopped by owner."));
    await recovery.cancel({ projectId, taskId: ticketId, executionId: current.details.execution_id });
    await eventBus.publish({ type: "task.failed", event_id: `CODER-STOP-${current.details.execution_id}`, project_id: projectId,
      task_id: ticketId, supervisor_id: `SUP-${ticketId}`, request_id: `STOP-${ticketId}`, correlation_id: `CORR-${ticketId}`, attempt: 1,
      payload: { reason: "TICKET_STOPPED", retryable: false, execution_id: current.details.execution_id, execution_basis: current.details.execution_basis } });
    return { ticket_id: ticketId, status: "stopping" };
  }

  // Publishes exhaustion only for the original execution, with a stable deduplicated event identity.
  async function publishTerminal({ request, event_id, reason }) {
    if (!await validateExecution(request)) return;
    const checkpoint = await checkpoints.load(request.task_id);
    if (checkpoint) await checkpoints.save({ ...checkpoint, status: "failed", phase: "operational_retry_exhausted" });
    await eventBus.publish({ type: "task.failed", event_id, project_id: request.project_id, task_id: request.task_id,
      supervisor_id: request.supervisor_id ?? `SUP-${request.task_id}`, request_id: request.request_id, correlation_id: request.correlation_id,
      attempt: request.attempt ?? 1, payload: { reason, retryable: false, execution_id: request.payload.execution_id, execution_basis: request.payload.sprint_basis } });
    const claim = agentOccupancy?.getByTask(request.task_id);
    if (claim?.supervisor_id === request.supervisor_id) await agentOccupancy.release({ claimId: claim.claim_id, taskId: request.task_id, supervisorId: claim.supervisor_id, reason });
  }
}

// Exposes bounded operational failures using existing coded-error semantics.
function failure(code, message) { return Object.assign(new Error(message), { code, statusCode: 409, retryable: false }); }
