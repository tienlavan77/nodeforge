// Wires automatic blocker investigation to parked ticket authority, checkpoint resume and owner-decision audit.
import { createBlockerRecovery } from "./blocker-recovery.js";
import { createBlockerRecoveryAgent } from "./blocker-recovery-agent.js";
import { validateBlockerDisposition, BLOCKER_REASONS } from "./blocker-recovery-contract.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { assertApprovedTicket } from "../governance/sprint-plan-draft.js";
import { approvedTicketDecisions } from "../governance/plan-decision-requests.js";
import { assertDependencyExpectations } from "./ticket-dependency-expectations.js";
import { preflightBlockerContract } from "./blocker-contract-preflight.js";
import { approvedBlockerArchitecture } from "./blocker-decision-authority.js";
import { blockerAuthorityPassages } from "./blocker-authority-passages.js";
import { recordTicketStage } from "./ticket-stage-progress.js";

const SOURCE_FIELDS = ["source_revision", "base_sha", "manifest_sha", "review_commit_sha"];

// Enables automatic SL/Architecture coordination only for Registry-bound ticket workspaces.
export function createProductionBlockerRecovery({ store, fileService, ticketStatusStore, sprintRegistry, resolveTicketWorkspace, checkpoints,
  eventBus, agentResolver, agentOccupancy, gateways, submitTicket, disposition, projectLogger = () => {}, logger = console,
  investigate, stopExecution, architecturePlans, replanFoundation, clock = Date.now, limits } = {}) {
  if (!ticketStatusStore?.listByStatus || !sprintRegistry || !resolveTicketWorkspace || !agentOccupancy) return null;
  const worker = investigate ?? createBlockerRecoveryAgent({ agentResolver, agentOccupancy, gateways, resolveTicketWorkspace, projectLogger, clock });
  const recovery = createBlockerRecovery({ store, validate, investigate: investigateStage, checkDisposition, resume, notify, clock, logger, ...limits });
  eventBus.subscribe("*", async (event) => {
    if (event.type === "task.needs_human_review" && event.payload?.reason === "CODER_BLOCKED") await captureSafely(event.task_id, event);
  });
  return Object.freeze({ ...recovery, recover, stopTicket, resumeTicket, preflight: (request) => preflightBlockerContract(request,
    { sprintRegistry, resolveTicketWorkspace, checkpoints, eventBus, projectLogger, agentOccupancy }) });

  // Recovers existing structured Coder blockers so an owner need not copy logs or reset tickets after deployment.
  async function recover() {
    for (const current of ticketStatusStore.listByStatus("needs_human_review")) await captureSafely(current.ticket_id ?? current.task_id);
  }

  // Keeps one stale Sprint or storage fault from preventing other parked tickets and terminal events from progressing.
  async function captureSafely(taskId, event) {
    try { return await capture(taskId, event); }
    catch (error) { projectLogger({ event_name: "ticket.blocker_capture_failed", level: "error", status: "failed", task_id: taskId,
      message: "Automatic blocker intake failed; checkpoint retained for recovery.", payload: { code: error.code, error: error.message } }); return null; }
  }

  // Captures only the current blocked checkpoint and exact approved ticket, never an arbitrary error string.
  async function capture(taskId, event) {
    const current = ticketStatusStore.get(taskId);
    if (!current?.details?.execution_id || !["running", "needs_human_review"].includes(current.status) || current.details.launch_claim) return;
    if (event && !matchesTicketExecution(current, event.payload?.execution_id, event.payload?.execution_basis)) return;
    const checkpoint = await checkpoints.load(taskId);
    const reason = checkpoint?.triage?.reason_code;
    if (checkpoint?.status !== "blocked" || checkpoint.failure?.code !== "CODER_BLOCKED" || !BLOCKER_REASONS.includes(reason)) return;
    const basis = current.details.execution_basis;
    const { plan } = await sprintRegistry.assertReady(basis.sprint_id, { expectedVersion: basis.version });
    const spec = plan.content.ticket_specs?.find((ticket) => ticket.id === taskId);
    if (!spec) return;
    const ticket = { ...spec, project_id: current.project_id, sprint_id: basis.sprint_id };
    const choices = approvedTicketDecisions(plan, taskId);
    if (choices.length) ticket.owner_decisions = choices;
    const architecture = await approvedBlockerArchitecture(plan, current.project_id, architecturePlans);
    const workspace = await resolveTicketWorkspace(taskId);
    const context = await workspace.executionContexts.load(taskId);
    if (!context || context.project_id !== current.project_id || context.state === "terminal") return;
    const job = await recovery.enqueue({ reason_code: reason, failure_at: checkpoint.failure.at, message: checkpoint.failure.message, architecture_basis: architecture?.basis ?? null,
      evidence: checkpoint.triage.evidence_refs ?? [], request: { task_id: taskId, project_id: current.project_id, ticket,
        supervisor_id: `SUP-${taskId}`, request_id: checkpoint.failure_request_id ?? event?.request_id ?? `BLOCKED-${checkpoint.failure.at}`,
        correlation_id: checkpoint.correlation_id ?? `CORR-${taskId}`, execution_context: context,
        payload: { execution_id: current.details.execution_id, sprint_basis: basis, dependency_expectations: current.details.dependency_expectations } } });
    const latest = await checkpoints.load(taskId);
    if (job?.status === "pending" && latest?.failure?.at === checkpoint.failure.at) await checkpoints.save({ ...latest,
      phase: "blocker_triage_pending", blocker_recovery: { job_id: job.id, status: "pending", reason_code: reason } });
    if (job) await recordTicketStage({ checkpoints, taskId, stage: "sprint_leader", status: job.status === "pending" ? "in_progress" : job.status, details: { job_id: job.id }, logger, clock });
    return job;
  }

  // Revalidates cancellation, plan, dependency intent, source identity and the exact failure before every stage.
  async function inspect(job) {
    const request = job.request;
    const current = ticketStatusStore.get(request.task_id);
    if (!matchesTicketExecution(current, request.payload.execution_id, request.payload.sprint_basis)
      || !["needs_human_review", "running"].includes(current.status)
      || current.details.reason === "TICKET_STOPPED" || (await disposition?.get(request.task_id))?.disposition === "cancelled") return null;
    const checkpoint = await checkpoints.load(request.task_id);
    const resuming = ["dispatching", "notification_pending", "notifying"].includes(job.status)
      && checkpoint?.phase === "blocker_resolved" && checkpoint.blocker_recovery?.job_id === job.id;
    if (!resuming && (current.details.launch_claim || checkpoint?.status !== "blocked" || checkpoint.failure?.at !== job.failure_at)) return null;
    const { plan } = await sprintRegistry.assertReady(request.ticket.sprint_id, { expectedVersion: request.payload.sprint_basis.version });
    assertApprovedTicket(plan, request.ticket);
    approvedTicketDecisions(plan, request.task_id);
    const architecture = await approvedBlockerArchitecture(plan, request.project_id, architecturePlans);
    if (JSON.stringify(architecture?.basis ?? null) !== JSON.stringify(job.architecture_basis ?? null)) return null;
    assertDependencyExpectations({ projectId: request.project_id, ticket: request.ticket,
      expectations: request.payload.dependency_expectations, sprintRegistry, ticketStatusStore });
    const workspace = await resolveTicketWorkspace(request.task_id);
    const context = await workspace.executionContexts.load(request.task_id);
    if (!context || context.project_id !== request.project_id || context.state === "terminal"
      || SOURCE_FIELDS.some((field) => context[field] !== request.execution_context[field])) return null;
    return { current, checkpoint, workspace, plan, architecture };
  }

  // Gives each role current, Node-verified boundaries rather than letting agents invent their own approval basis.
  async function investigateStage(job, options) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Decision authority changed before investigation.");
    await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: job.stage, status: "in_progress", details: { job_id: job.id }, logger, clock });
    const { objective, in_scope, out_of_scope, approach, acceptance_criteria } = authority.plan.content;
    return worker({ ...job, authority_context: { sprint: { objective, in_scope, out_of_scope, approach, acceptance_criteria }, architecture: authority.architecture,
      passages: blockerAuthorityPassages({ plan: authority.plan, ticket: job.request.ticket, architecture: authority.architecture }) } }, options);
  }

  // Cancels stale authority while making a failed revalidation observable in the project audit.
  async function validate(job) {
    try { return Boolean(await inspect(job)); }
    catch (error) { logger.warn?.("Blocker authority could not be revalidated.", { task_id: job.request.task_id, code: error.code, error: error.message }); return false; }
  }

  // Verifies cached or fresh disposition evidence against the current approved plan and live source.
  async function checkDisposition(value, job) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Blocker authority changed during investigation.");
    const verified = await validateBlockerDisposition(value, { job, plan: authority.plan, architecture: authority.architecture,
      fileService: (authority.workspace.root_only ? authority.workspace.fileService : authority.workspace.worktreeFileService ?? authority.workspace.fileService) ?? fileService,
      projectRoot: authority.workspace.path ?? authority.workspace.projectRoot });
    await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: job.stage, status: "completed", details: { job_id: job.id, action: verified.action }, logger, clock });
    if (verified.action !== "resolved" && job.stage === "sprint_leader") {
      await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: "architecture_manager", status: "in_progress", details: { job_id: job.id }, logger, clock });
    }
    return verified;
  }

  // Resumes unchanged work under its original execution using the same transactional launch and review gates.
  async function resume(job) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Blocker source changed before resume.");
    const { current } = authority;
    const checkpoint = (await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: "coder", status: "resumed_from_blocker", details: { job_id: job.id }, logger, clock })) ?? authority.checkpoint;
    const resumed = { ...checkpoint, status: "in_progress", phase: "blocker_resolved", blocker_recovery: {
      job_id: job.id, status: "resolved", disposition: job.resolution, history: job.history } };
    delete resumed.failure;
    try {
      await store.withLock("blocker.recovery", async () => {
        const ledger = (await store.list("blocker.recovery")).find((entry) => entry.jobs.some((item) => item.id === job.id));
        if (!ledger || ledger.cancelled || ledger.jobs.find((item) => item.id === job.id)?.status !== "dispatching") throw new Error("Blocker resume was cancelled.");
        await checkpoints.save(resumed);
        ticketStatusStore.resumeBlockedExecution(job.request.task_id, { executionId: job.request.payload.execution_id,
          basis: job.request.payload.sprint_basis, expectedVersion: current.version,
          dependencyExpectations: job.request.payload.dependency_expectations,
          validate: () => assertDependencyExpectations({ projectId: job.request.project_id, ticket: job.request.ticket,
            expectations: job.request.payload.dependency_expectations, sprintRegistry, ticketStatusStore }) });
      });
      return await submitTicket({ ...job.request, request_id: `BLOCKER-RESUME-${job.id}`,
        payload: { ...job.request.payload, retry_source_identity: job.request.execution_context, resume_from: resumed } });
    } catch (error) {
      const latest = ticketStatusStore.get(job.request.task_id);
      const saved = await checkpoints.load(job.request.task_id);
      if (matchesTicketExecution(latest, job.request.payload.execution_id, job.request.payload.sprint_basis) && !latest.details.launch_claim
        && saved?.phase === "blocker_resolved" && saved.blocker_recovery?.job_id === job.id
        && ((latest.status === "needs_human_review" && latest.version === current.version)
          || (latest.status === "running" && latest.version === current.version + 1))) {
        if (latest.status === "running") ticketStatusStore.updateStatus(job.request.task_id, "needs_human_review", { ...latest.details, reason: "blocker_resume_failed" },
          { expectedVersion: latest.version, expectedExecutionId: latest.details.execution_id });
        await checkpoints.save(checkpoint);
      }
      throw error;
    }
  }

  // Publishes one durable owner/reconciliation request with the complete agent proposal instead of manual coordination.
  async function notify(job) {
    const authority = await inspect(job);
    if (!authority) return;
    const ownerRequired = job.stage === "architecture_manager" && job.resolution?.action === "owner_required";
    const status = ownerRequired ? "owner_required" : "reconciliation_required";
    const updatedCheckpoint = (await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: ownerRequired ? "owner_decision" : job.stage ?? "sprint_leader", status,
      details: { job_id: job.id, outcome_reason: job.outcome_reason ?? null }, logger, clock })) ?? authority.checkpoint;
    const foundationEligible = ownerRequired && job.resolution?.escalation?.boundary === "owner_scope";
    const prepareFoundation = typeof replanFoundation === "function" ? replanFoundation : replanFoundation?.prepare?.bind(replanFoundation);
    const foundation = foundationEligible && prepareFoundation ? await prepareFoundation({ job, plan: authority.plan, architecture: authority.architecture }).catch((error) => ({ status: "failed", error: error.message, code: error.code })) : null;
    const proposal = job.resolution?.proposal ?? { title: "Automatic blocker recovery needs reconciliation",
      options: [{ id: "reconcile", description: `Inspect persisted investigation evidence: ${job.outcome_reason}. Do not reset or replay an unknown provider invocation.` }], recommended_option_id: "reconcile" };
    if (authority.current.status === "needs_human_review" && !authority.current.details.launch_claim) await checkpoints.save({ ...updatedCheckpoint, status: "blocked", phase: ownerRequired ? "owner_decision" : "blocker_reconciliation_required", blocker_recovery: {
      job_id: job.id, status, reason: job.outcome_reason, proposal, escalation: ownerRequired ? job.resolution.escalation : null, history: job.history,
      disposition_attempts: job.disposition_attempts ?? [], validation_feedback: job.validation_feedback ?? [], foundation_replan: foundation, last_error: job.last_error ?? null } });
    const request = job.request;
    await eventBus.publish({ type: `task.blocker.${ownerRequired ? "owner_decision_required" : "reconciliation_required"}`, event_id: `BLOCKER-DECISION-${job.id}`, task_id: request.task_id,
      project_id: request.project_id, supervisor_id: request.supervisor_id, request_id: request.request_id,
      correlation_id: request.correlation_id, attempt: 1, payload: { job_id: job.id, reason: job.outcome_reason, proposal,
        execution_id: request.payload.execution_id, execution_basis: request.payload.sprint_basis, foundation_replan: foundation } });
    projectLogger({ event_name: `ticket.blocker_${ownerRequired ? "owner_decision_required" : "reconciliation_required"}`, level: "warn", status: "blocked", task_id: request.task_id,
      message: ownerRequired ? "Architecture investigation exceeded its authority and needs a bounded owner decision."
        : `Automatic blocker investigation needs technical reconciliation (${job.outcome_reason}): ${job.last_error ?? "No valid disposition was established."} No new owner policy decision was established.`,
      payload: { job_id: job.id, proposal, reason: job.outcome_reason, foundation_replan: foundation, validation_feedback: job.validation_feedback ?? [] } });
  }

  // Stops automatic investigation without approving, discarding or restarting the blocked work.
  async function stopTicket({ projectId, ticketId }) {
    const current = ticketStatusStore.get(ticketId);
    if (current?.project_id !== projectId || !await recovery.hasPending({ projectId, taskId: ticketId, executionId: current.details?.execution_id })) throw new Error("Ticket has no active blocker recovery.");
    await recovery.cancel({ projectId, taskId: ticketId, executionId: current.details.execution_id });
    worker.cancel?.(ticketId);
    const latest = ticketStatusStore.get(ticketId);
    if (["running", "reviewing"].includes(latest?.status)) {
      if (!stopExecution) throw new Error("Active Coder requires its provider Stop adapter.");
      return stopExecution({ projectId, ticketId });
    }
    const checkpoint = await checkpoints.load(ticketId);
    if (checkpoint?.blocker_recovery && matchesTicketExecution(ticketStatusStore.get(ticketId), current.details.execution_id, current.details.execution_basis)) {
      const stopped = (await recordTicketStage({ checkpoints, taskId: ticketId, stage: checkpoint.stage_progress?.at(-1)?.stage ?? "sprint_leader", status: "cancelled", details: { job_id: checkpoint.blocker_recovery.job_id }, logger, clock })) ?? checkpoint;
      await checkpoints.save({ ...stopped, phase: "blocker_triage_cancelled", blocker_recovery: { ...stopped.blocker_recovery, status: "cancelled" } });
    }
    return { ticket_id: ticketId, status: "stopping" };
  }

  // Re-arms a cancelled or errored SL/AM stage at its recorded checkpoint position; never replays unknown provider calls.
  async function resumeTicket({ projectId, ticketId }) {
    const current = ticketStatusStore.get(ticketId);
    if (current?.project_id !== projectId) throw new Error("Ticket belongs to a different project.");
    const checkpoint = await checkpoints.load(ticketId);
    const last = Array.isArray(checkpoint?.stage_progress) ? checkpoint.stage_progress.at(-1) : null;
    if (!checkpoint?.blocker_recovery || !["cancelled", "reconciliation_required"].includes(checkpoint.blocker_recovery.status)
      || (last && !["sprint_leader", "architecture_manager"].includes(last.stage))) throw new Error("Ticket has no resumable blocker recovery stage.");
    const job = await recovery.resumeStage({ projectId, taskId: ticketId, executionId: current?.details?.execution_id, jobId: checkpoint.blocker_recovery.job_id });
    if (!job) throw Object.assign(new Error("Blocker stage cannot resume: the provider outcome is unknown or the ledger was replaced."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
    const resumedCheckpoint = (await recordTicketStage({ checkpoints, taskId: ticketId, stage: job.stage, status: "in_progress", details: { job_id: job.id, resumed: true }, logger, clock })) ?? checkpoint;
    await checkpoints.save({ ...resumedCheckpoint, status: "blocked", phase: "blocker_triage_pending", blocker_recovery: { ...resumedCheckpoint.blocker_recovery, job_id: job.id, status: "pending", stage: job.stage } });
    return { ticket_id: ticketId, ...(current?.details?.execution_id ? { execution_id: current.details.execution_id } : {}), status: "accepted", pipeline: "supervisor", resumed: true, resumed_stage: job.stage, resumed_from_turn: checkpoint.last_completed_turn ?? 0, job_id: job.id };
  }
}
