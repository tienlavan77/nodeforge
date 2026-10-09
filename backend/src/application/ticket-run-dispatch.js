// Dispatches individual and Sprint tickets through the same approval, resume, and status lifecycle.
import { randomUUID } from "node:crypto";
import { assertApprovedTicket } from "../modules/governance/sprint-plan-draft.js";
import { matchesTicketExecution, sameExecutionPlan } from "../modules/projects/ticket-execution-identity.js";
import { assertA5ExecutionContract } from "../modules/governance/sprint-plan-execution-gates.js";
import { reviewPhaseResume, reviewRevisionResume } from "../modules/supervisor/review-revision-resume.js";
import { assertDependencyExpectations, captureDependencyExpectations } from "../modules/supervisor/ticket-dependency-expectations.js";

// Creates one shared ticket RUN entry point so Sprint execution preserves all ticket gates.
export function createTicketRunDispatch({ disposition, intake, sprintRegistry, ticketStatusStore, checkpoints, queueStore, protocolStorage, conversationStateStore, dispatchTask }) {
  const active = new Map();
  dispatchTicket.stop = ({ projectId, ticketId } = {}) => {
    const run = active.get(ticketId);
    if (!run || run.projectId !== projectId) throw failure("TICKET_NOT_RUNNING", "This ticket has no active RUN to stop.");
    run.controller.abort(Object.assign(new Error("Ticket stopped by owner."), { code: "TICKET_STOPPED" }));
    return { ticket_id: ticketId, status: "stopping" };
  };
  return dispatchTicket;
  async function dispatchTicket({ projectId, ticketId, fresh = false, expectedSprintVersion, dependencyExpectations } = {}) {
    dependencyExpectations = dependencyExpectations === undefined ? undefined : structuredClone(dependencyExpectations);
    if (active.has(ticketId)) return { ticket_id: ticketId, status: "already_running", pipeline: "supervisor" };
    const controller = new AbortController();
    active.set(ticketId, { projectId, controller });
    try {
      if ((await disposition.get(ticketId))?.disposition === "cancelled") throw failure("TICKET_CANCELLED", "This historical ticket was cancelled by the project owner and cannot be resumed.");
      const { ticket } = await intake.open({ projectId, ticketId });
      if (!sprintRegistry.get(ticket.sprint_id)) throw failure("SPRINT_PLAN_REQUIRED", "Ticket sprint has no approved plan in the sprint registry.");
      const { sprint: sprintBasis, plan } = await sprintRegistry.assertReady(ticket.sprint_id, { expectedVersion: expectedSprintVersion });
      assertApprovedTicket(plan, ticket);
      assertA5ExecutionContract(ticket);
      if (sprintBasis && dependencyExpectations === undefined) dependencyExpectations = await captureDependencyExpectations({ projectId, ticket, sprintRegistry, ticketStatusStore });
      assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
      const current = ticketStatusStore.get(ticketId);
      if (current?.status === "cancelled") throw failure("TICKET_CANCELLED", "Cancelled tickets cannot run.");
      if (current?.status === "blocked") throw failure("TICKET_APPROVAL_REQUIRED", "Blocked ticket status requires a human decision before RUN.");
      if (current?.details?.reason === "human_review_approved" || current?.status === "done" && !fresh) {
        if (sprintBasis && !sameExecutionPlan(current.details?.execution_basis, sprintBasis)) throw failure("TICKET_EXECUTION_RECONCILIATION_REQUIRED", "Existing completion is not evidence for this immutable Sprint plan; reconcile or explicitly request a fresh RUN.");
        return { ticket_id: ticketId, status: "completed", pipeline: "supervisor", resumed: true, ...(current.details?.execution_id ? { execution_id: current.details.execution_id } : {}) };
      }
      const storedCheckpoint = await checkpoints.load(ticketId);
      if (storedCheckpoint?.status === "blocked") throw failure("TICKET_APPROVAL_REQUIRED", "Coder checkpoint requires a human decision before this ticket can run again.");
      const checkpoint = fresh ? null : storedCheckpoint;
      const resume = checkpoint && checkpoint.status !== "completed" ? await reviewRevisionResume(queueStore, ticketId, checkpoint) : null;
      const reviewerCheckpoint = !fresh && checkpoint?.status === "completed" ? await checkpoints.loadReview(ticketId) : null;
      if (reviewerCheckpoint?.verdict === "approved") throw failure("TICKET_INTEGRATION_RECOVERY_REQUIRED", "Review is approved but ticket completion is missing; recover integration before RUN.");
      const reviewResume = !fresh && checkpoint?.status === "completed" ? reviewPhaseResume(checkpoint, reviewerCheckpoint) : null;
      if (controller.signal.aborted) throw controller.signal.reason;
      const executionId = sprintBasis && ticketStatusStore.beginExecution ? `RUN-${randomUUID()}` : null;
      if (executionId) {
        await sprintRegistry.assertReady(ticket.sprint_id, { expectedVersion: sprintBasis.version });
        assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
        ticketStatusStore.beginExecution(ticketId, { executionId, basis: sprintBasis, expectedVersion: current?.version ?? 0, fresh, dependencyExpectations });
      } else prepareStatus(ticketStatusStore, ticketId, fresh);
      const correlationId = `CORR-UI-RUN-${ticketId}-${Date.now()}`;
      let result;
      try {
        if (!resume && !reviewResume) {
          await checkpoints.clear(ticketId);
          await protocolStorage.clearTask(ticketId);
          await conversationStateStore.clear(`CONV-BUILDER-${projectId}-${ticketId}`);
        }
        assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
        result = await dispatchTask({ ticket, sprintBasis, executionId, dependencyExpectations, message: { id: `REQ-${ticketId}-${Date.now()}`, correlation_id: correlationId }, abortSignal: controller.signal, ...(resume ? { resume_from: resume } : {}), ...(reviewResume ? { review_resume: reviewResume } : {}) });
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) {
        const failed = ticketStatusStore.get(ticketId);
        if (["running", "reviewing"].includes(failed?.status) && (!executionId || matchesTicketExecution(failed, executionId, sprintBasis))) {
          try { ticketStatusStore.updateStatus(ticketId, "failed", { reason: "ticket_dispatch_failed", error: error.message }, executionId ? { expectedVersion: failed.version, expectedExecutionId: executionId } : {}); }
          catch (statusError) { if (statusError.code !== "STATUS_CONFLICT") throw statusError; error.execution_status_conflict = statusError.message; }
        }
        throw error;
      }
      return { ticket_id: ticketId, ...(executionId ? { execution_id: executionId } : {}), supervisor_id: result.supervisor_id, status: result.status === "completed" ? "completed" : result.status === "already_running" ? "already_running" : result.status === "needs_human_review" ? "needs_human_review" : "accepted", pipeline: "supervisor", ...(resume || reviewResume ? { resumed: true, resumed_from_turn: checkpoint?.last_completed_turn ?? 0 } : {}) };
    } finally { active.delete(ticketId); }
  }
}

// Creates the durable status before execution so terminal events can open dependent tickets.
function prepareStatus(store, ticketId, fresh) {
  let current = store.get(ticketId) ?? store.create(ticketId);
  if (current.status === "done" && fresh) current = store.resetDoneForRetry(ticketId, { reason: "fresh_run" });
  if (["failed", "needs_human_review"].includes(current.status)) current = store.retry(ticketId, { reason: "run_resume" });
  if (current.status === "blocked") throw failure("TICKET_APPROVAL_REQUIRED", "Blocked ticket status requires a human decision before RUN.");
  if (current.status === "pending") store.updateStatus(ticketId, "running", { reason: "ticket_run" });
}

// Exposes stable RUN failures through the canonical API envelope.
function failure(code, message) { return Object.assign(new Error(message), { code, statusCode: 409 }); }
