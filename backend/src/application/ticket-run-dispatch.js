// Dispatches individual and Sprint tickets through the same approval, resume, and status lifecycle.
import { assertAutomaticReviewResume } from "../modules/supervisor/review/automatic-review-stage.js";
import { randomUUID } from "node:crypto";
import { assertApprovedTicket } from "../modules/governance/sprint-plan-draft.js";
import { matchesTicketExecution, sameExecutionPlan } from "../modules/projects/ticket-execution-identity.js";
import { assertA5ExecutionContract } from "../modules/governance/sprint-plan-execution-gates.js";
import { reviewPhaseResume, reviewRevisionResume } from "../modules/supervisor/review/review-revision-resume.js";
import { assertDependencyExpectations, captureDependencyExpectations } from "../modules/supervisor/ticket/ticket-dependency-expectations.js";
import { coderEvidenceResume } from "../modules/supervisor/coder/coder-evidence-resume.js";
import { approvedTicketDecisions } from "../modules/governance/plan-decision-requests.js";
import { BLOCKER_RESUME_STATUSES } from "../modules/supervisor/blocker/blocker-resume-checkpoint.js";
import { assertTicketCoderAvailable } from "../modules/supervisor/ticket/ticket-agent-availability.js";
import { assertDependencyRepairDispatch } from "../modules/supervisor/coder/dependency-repair-contract.js";
import { createTicketRunAgentWait } from "./ticket-run-agent-wait.js";
import { classifyCoderFailure } from "../modules/supervisor/coder/coder-failure-routing.js";

// Creates one shared ticket RUN entry point so Sprint execution preserves all ticket gates.
export function createTicketRunDispatch({ disposition, intake, sprintRegistry, ticketStatusStore, checkpoints, queueStore, protocolStorage, conversationStateStore, dispatchTask, coderRecovery, blockerRecovery, resumeCompletedReview, reconcileReviewDependencies, agentResolver, agentOccupancy, projectId, projectLogger, clock }) {
  const active = new Map();
  dispatchTicket.stop = ({ projectId, ticketId } = {}) => {
    if (blockerRecovery) return stopRecovery({ projectId, ticketId });
    return stopRun({ projectId, ticketId });
  };
  // Cancels parked automatic triage before falling back to the active provider Stop boundary.
  async function stopRecovery({ projectId, ticketId }) {
    const current = ticketStatusStore.get(ticketId);
    if (await blockerRecovery.hasPending({ projectId, taskId: ticketId, executionId: current?.details?.execution_id })) return blockerRecovery.stopTicket({ projectId, ticketId });
    return stopRun({ projectId, ticketId });
  }
  // Preserves synchronous legacy Stop behavior when no parked blocker investigation owns the ticket.
  function stopRun({ projectId, ticketId }) {
    const run = active.get(ticketId);
    if (coderRecovery?.stopTicket) return coderRecovery.stopTicket({ projectId, ticketId });
    if (!run || run.projectId !== projectId) throw failure("TICKET_NOT_RUNNING", "This ticket has no active RUN to stop.");
    run.controller.abort(Object.assign(new Error("Ticket stopped by owner."), { code: "TICKET_STOPPED" }));
    return { ticket_id: ticketId, status: "stopping" };
  }
  return queueStore?.withLock ? createTicketRunAgentWait({ dispatch: dispatchTicket, queueStore, ticketStatusStore, projectId, projectLogger, clock }) : dispatchTicket;
  // Defines dispatchTicket function behavior for ticket-run-dispatch.js.
  async function dispatchTicket({ projectId, ticketId, fresh = false, expectedSprintVersion, dependencyExpectations, commitAuthorization, expectedExecutionBasis, waitSignal, waitGuard, waitVersion, dependencyRepair } = {}) {
    if (commitAuthorization && fresh) throw failure("COMMIT_AUTHORIZATION_SCOPE", "Commit consent resumes the retained checkpoint; fresh RUN is not allowed.");
    dependencyExpectations = dependencyExpectations === undefined ? undefined : structuredClone(dependencyExpectations);
    if (active.has(ticketId)) return { ticket_id: ticketId, status: "already_running", pipeline: "supervisor" };
    const controller = new AbortController();
    // Carries Owner Stop from the durable wait reservation into the ordinary RUN cancellation boundary.
    const stopWaiting = () => controller.abort(waitSignal.reason);
    if (waitSignal?.aborted) stopWaiting();
    waitSignal?.addEventListener("abort", stopWaiting, { once: true });
    active.set(ticketId, { projectId, controller });
    try {
      if ((await disposition.get(ticketId))?.disposition === "cancelled") throw failure("TICKET_CANCELLED", "This historical ticket was cancelled by the project owner and cannot be resumed.");
      await assertDependencyRepairDispatch(dependencyRepair, { ticketId, ticketStatusStore, queueStore, disposition });
      const { ticket } = await intake.open({ projectId, ticketId });
      if (!sprintRegistry.get(ticket.sprint_id)) throw failure("SPRINT_PLAN_REQUIRED", "Ticket sprint has no approved plan in the sprint registry.");
      const { sprint: sprintBasis, plan } = await sprintRegistry.assertReady(ticket.sprint_id, { expectedVersion: expectedSprintVersion });
      if (expectedExecutionBasis && (!sameExecutionPlan(expectedExecutionBasis, sprintBasis) || expectedExecutionBasis.version !== sprintBasis.version)) throw failure("TICKET_EXECUTION_RECONCILIATION_REQUIRED", "Queued RUN no longer matches its approved Sprint revision.");
      assertApprovedTicket(plan, ticket);
      const ownerDecisions = approvedTicketDecisions(plan, ticketId);
      if (ownerDecisions.length) {
        ticket.owner_decisions = ownerDecisions;
        ticket.owner_decision_basis = { plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, decision_id: ownerDecisions[0].decision_id };
      }
      assertA5ExecutionContract(ticket);
      if (sprintBasis && dependencyExpectations === undefined) dependencyExpectations = await captureDependencyExpectations({ projectId, ticket, sprintRegistry, ticketStatusStore });
      assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
      let current = ticketStatusStore.get(ticketId);
      if (current?.details.dependency_repair?.state === "preparing") throw failure("DEPENDENCY_REPAIR_PREPARING", "Node is preparing the dependency repair journal; the saved Coder checkpoint will become runnable when preparation finishes.");
      if (waitVersion !== undefined && current?.version !== waitVersion) throw failure("STATUS_CONFLICT", "Queued RUN ticket state was replaced before dispatch.");
      if (current?.project_id === projectId && await blockerRecovery?.hasPending({ projectId, taskId: ticketId, executionId: current.details?.execution_id })) return { ticket_id: ticketId, status: "already_running", pipeline: "supervisor", reason: "blocker_recovery_pending" };
      if (current?.project_id === projectId && ["running", "reviewing"].includes(current.status) && await coderRecovery?.hasPending({ projectId, taskId: ticketId, executionId: current.details?.execution_id })) return { ticket_id: ticketId, status: "already_running", pipeline: "supervisor", reason: "operational_recovery_pending" };
      if (current?.status === "cancelled") throw failure("TICKET_CANCELLED", "Cancelled tickets cannot run.");
      const storedCheckpoint = await checkpoints.load?.(ticketId);
      if (!fresh && reconcileReviewDependencies && current?.details?.review_reopen) current = await reconcileReviewDependencies({ projectId, ticket, current,
        checkpoint: storedCheckpoint, dependencyExpectations, reviewCheckpoint: await checkpoints.loadReview?.(ticketId) });
      if (!commitAuthorization && !fresh && storedCheckpoint?.status === "blocked" && coderRecovery?.resumeTicket) {
        const retry = await coderRecovery.resumeTicket({ projectId, ticketId, ticket });
        if (retry) return retry;
      }
      if (current?.status === "blocked") throw failure("TICKET_APPROVAL_REQUIRED", "Blocked ticket status requires a human decision before RUN.");
      if (current?.details?.reason === "human_review_approved" || current?.status === "done" && !fresh) {
        if (sprintBasis && !sameExecutionPlan(current.details?.execution_basis, sprintBasis)) throw failure("TICKET_EXECUTION_RECONCILIATION_REQUIRED", "Existing completion is not evidence for this immutable Sprint plan; reconcile or explicitly request a fresh RUN.");
        return { ticket_id: ticketId, status: "completed", pipeline: "supervisor", resumed: true, ...(current.details?.execution_id ? { execution_id: current.details.execution_id } : {}) };
      }
      if (!fresh && current?.details?.review_reopen && !current.details.review_reopen.repair_cycle_id && current.status === "reviewing") {
        if (!resumeCompletedReview) throw failure("REVIEW_WORKER_UNAVAILABLE", "Retained review resume is unavailable.");
        return await resumeCompletedReview({ projectId, ticketId });
      }
      if (["owner_decided", "governance_required"].includes(storedCheckpoint?.blocker_recovery?.status)
        || storedCheckpoint?.blocker_recovery?.status === "owner_required" && (storedCheckpoint.blocker_owner_decisions?.length || current?.details?.owner_decision)) {
        if (!blockerRecovery?.fulfillOwnerDecision) throw failure("BLOCKER_GOVERNANCE_UNAVAILABLE", "Architecture handoff is required before Coder can resume.");
        return await blockerRecovery.fulfillOwnerDecision({ projectId, ticketId });
      }
      if (!fresh && storedCheckpoint?.status === "blocked" && BLOCKER_RESUME_STATUSES.includes(storedCheckpoint.blocker_recovery?.status) && typeof blockerRecovery?.resumeTicket === "function") {
        return await blockerRecovery.resumeTicket({ projectId, ticketId, ...(commitAuthorization ? { commitAuthorization } : {}) });
      }
      if (commitAuthorization) throw failure("COMMIT_AUTHORIZATION_SCOPE", "Commit consent requires a retained blocker recovery checkpoint.");
      const stoppedCheckpoint = storedCheckpoint?.failure?.code === "TICKET_STOPPED"
        && (!storedCheckpoint.blocker_recovery || ["resolved", "superseded_by_review"].includes(storedCheckpoint.blocker_recovery.status));
      const repairCheckpoint = storedCheckpoint?.status === "blocked" && classifyCoderFailure(storedCheckpoint.failure) === "repair"
        && (!storedCheckpoint.blocker_recovery || ["resolved", "superseded_by_review"].includes(storedCheckpoint.blocker_recovery.status));
      if (storedCheckpoint?.status === "blocked" && !storedCheckpoint.blocker_recovery?.owner_decision && !stoppedCheckpoint && !repairCheckpoint) throw failure("TICKET_APPROVAL_REQUIRED", "Coder checkpoint requires a human decision before this ticket can run again.");
      let checkpoint = fresh ? null : stoppedCheckpoint || repairCheckpoint ? { ...storedCheckpoint, status: "failed" } : storedCheckpoint;
      const reviewerCheckpoint = !fresh && checkpoint?.status === "completed" ? await checkpoints.loadReview(ticketId) : null;
      if (reviewerCheckpoint?.verdict === "approved") throw failure("TICKET_INTEGRATION_RECOVERY_REQUIRED", "Review is approved but ticket completion is missing; recover integration before RUN.");
      if (checkpoint?.status === "completed" && typeof protocolStorage.get === "function") {
        try {
          const report = (await protocolStorage.get(`task/${ticketId}/final_report`)).data;
          checkpoint = coderEvidenceResume(checkpoint, report) ?? checkpoint;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const resume = checkpoint?.phase === "coder_evidence_required" ? checkpoint : checkpoint && checkpoint.status !== "completed" ? await reviewRevisionResume(queueStore, ticketId, checkpoint) : null;
      const reviewResume = !fresh && checkpoint?.status === "completed" ? reviewPhaseResume(checkpoint, reviewerCheckpoint) : null;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (reviewResume) await assertAutomaticReviewResume(queueStore, ticketId, current?.details?.execution_id);
      const ticketRunWait = { expectedSprintVersion: sprintBasis?.version, expectedExecutionBasis: sprintBasis, dependencyExpectations, expectedTicketVersion: current?.version ?? 0 };
      if (!reviewResume) {
        await agentResolver?.refresh?.();
        try { assertTicketCoderAvailable({ resolver: agentResolver, occupancy: agentOccupancy, ticket, taskId: ticketId, ownerId: `SUP-${ticketId}`, payload: resume ? { resume_from: resume } : {} }); }
        catch (error) { error.ticket_run_wait = ticketRunWait; throw error; }
      }
      await assertDependencyRepairDispatch(dependencyRepair, { ticketId, ticketStatusStore, queueStore, disposition });
      await waitGuard?.();
      if (controller.signal.aborted) throw controller.signal.reason;
      const retainExecution = Boolean((reviewResume || resume) && ticketStatusStore.resumeReviewExecution && matchesTicketExecution(current, current?.details?.execution_id, sprintBasis));
      const executionId = retainExecution ? current.details.execution_id : sprintBasis && ticketStatusStore.beginExecution ? `RUN-${randomUUID()}` : null;
      if (executionId) {
        await sprintRegistry.assertReady(ticket.sprint_id, { expectedVersion: sprintBasis.version });
        assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
        await assertDependencyRepairDispatch(dependencyRepair, { ticketId, ticketStatusStore, queueStore, disposition });
        await waitGuard?.();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (retainExecution) ticketStatusStore.resumeReviewExecution(ticketId, { executionId, basis: sprintBasis, expectedVersion: current.version, dependencyExpectations, ...(resume ? { reason: "coder_resume" } : {}),
          validate: () => assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore }) });
        else ticketStatusStore.beginExecution(ticketId, { executionId, basis: sprintBasis, expectedVersion: current?.version ?? 0, fresh, dependencyExpectations });
      } else prepareStatus(ticketStatusStore, ticketId, fresh);
      const correlationId = `CORR-UI-RUN-${ticketId}-${Date.now()}`;
      let result;
      try {
        await assertDependencyRepairDispatch(dependencyRepair, { ticketId, ticketStatusStore, queueStore, disposition });
        await waitGuard?.();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!resume && !reviewResume) {
          await checkpoints.clear(ticketId);
          await protocolStorage.clearTask(ticketId);
          await conversationStateStore.clear(`CONV-BUILDER-${projectId}-${ticketId}`);
        }
        assertDependencyExpectations({ projectId, ticket, expectations: dependencyExpectations, sprintRegistry, ticketStatusStore });
        await assertDependencyRepairDispatch(dependencyRepair, { ticketId, ticketStatusStore, queueStore, disposition });
        await waitGuard?.();
        if (controller.signal.aborted) throw controller.signal.reason;
        result = await dispatchTask({ ticket, sprintBasis, executionId, dependencyExpectations, message: { id: `REQ-${ticketId}-${Date.now()}`, correlation_id: correlationId }, abortSignal: controller.signal, ...(resume ? { resume_from: resume } : {}), ...(reviewResume ? { review_resume: reviewResume } : {}) });
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) {
        const failed = ticketStatusStore.get(ticketId);
        if (["running", "reviewing"].includes(failed?.status) && (!executionId || matchesTicketExecution(failed, executionId, sprintBasis))) {
          try { ticketStatusStore.updateStatus(ticketId, "failed", { reason: "ticket_dispatch_failed", error: error.message }, executionId ? { expectedVersion: failed.version, expectedExecutionId: executionId } : {}); }
          catch (statusError) { if (statusError.code !== "STATUS_CONFLICT") throw statusError; error.execution_status_conflict = statusError.message; }
        }
        const parked = ticketStatusStore.get(ticketId);
        if (!reviewResume && error.code === "AGENT_BUSY" && error.not_started === true && !error.execution_status_conflict
          && (!executionId || matchesTicketExecution(parked, executionId, sprintBasis))) error.ticket_run_wait = { ...ticketRunWait, expectedTicketVersion: parked?.version };
        throw error;
      }
      return { ticket_id: ticketId, ...(executionId ? { execution_id: executionId } : {}), supervisor_id: result.supervisor_id, status: result.status === "failed" ? "failed" : result.status === "completed" ? "completed" : result.status === "already_running" ? "already_running" : result.status === "needs_human_review" ? "needs_human_review" : "accepted", pipeline: "supervisor", ...(resume || reviewResume ? { resumed: true, resumed_from_turn: checkpoint?.last_completed_turn ?? 0 } : {}) };
    } finally { waitSignal?.removeEventListener("abort", stopWaiting); active.delete(ticketId); }
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
