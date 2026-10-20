// Wires automatic blocker investigation to parked ticket authority, checkpoint resume and owner-decision audit.
import { createBlockerRecovery } from "./blocker-recovery.js";
import { createBlockerRecoveryAgent } from "./blocker-recovery-agent.js";
import { blockerDigest, validateBlockerDisposition } from "./blocker-recovery-contract.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { assertApprovedTicket } from "../governance/sprint-plan-draft.js";
import { blockerOwnerDecisions } from "./blocker-owner-decisions.js";
import { approvedTicketDecisions } from "../governance/plan-decision-requests.js";
import { createBlockerCapture } from "./blocker-recovery-capture.js";
import { createBlockerOwnerHandoff } from "./blocker-owner-handoff.js";
import { createBlockerGovernanceHandoff } from "./blocker-governance-handoff.js";
import { assertDependencyExpectations } from "./ticket-dependency-expectations.js";
import { preflightBlockerContract } from "./blocker-contract-preflight.js";
import { approvedBlockerArchitecture } from "./blocker-decision-authority.js";
import { blockerAuthorityPassages } from "./blocker-authority-passages.js";
import { recordTicketStage } from "./ticket-stage-progress.js";
import { blockerRecoveryPolicy } from "./blocker-recovery-policy.js";
import { inspectBlockerFileClaims } from "./blocker-file-claims.js";
import { buildBlockerTicketProgress } from "./blocker-ticket-progress.js";
import { createTicketContractSource } from "./ticket-contract-source.js";
import { createBlockerAdmission } from "./blocker-execution-admission.js";
import { createBlockerNotification } from "./blocker-notification.js";
import { createBlockerApprovalRetry } from "./blocker-approval-retry.js";
import { createBlockerFailureClassification } from "./blocker-failure-classification.js";
import { blockerValidationError } from "./blocker-validation.js";
import { createBlockerReconciliationRefresh } from "./blocker-reconciliation-refresh.js";
import { retainBlockerContract, readBlockerContracts, blockerContractPrompt } from "./blocker-contract-evidence.js";
const SOURCE_FIELDS = ["source_revision", "base_sha", "manifest_sha", "review_commit_sha"];
// Enables automatic SL/Architecture coordination only for Registry-bound ticket workspaces; `limits` defaults to the deploy-time policy.
export function createProductionBlockerRecovery({ store, fileService, projectId, ticketStatusStore, sprintRegistry, resolveTicketWorkspace, checkpoints,
  eventBus, agentResolver, agentOccupancy, gateways, submitTicket, disposition, projectLogger = () => {}, logger = console,
  investigate, readFailureEvidence, stopExecution, architecturePlans, replanFoundation, plans, planFileService, clock = Date.now, limits = blockerRecoveryPolicy() } = {}) {
  if (!ticketStatusStore?.listByStatus || !sprintRegistry || !resolveTicketWorkspace || !agentOccupancy) return null;
  const worker = investigate ?? createBlockerRecoveryAgent({ agentResolver, agentOccupancy, gateways, resolveTicketWorkspace, projectLogger, clock });
  const classifyFailure = createBlockerFailureClassification({ readFailureEvidence });
  const admission = createBlockerAdmission({ store, inspect, clock, projectLogger, readFailureEvidence });
  const notify = createBlockerNotification({ inspect, checkDisposition, prepareGovernance: (...args) => prepareGovernance(...args), checkpoints, eventBus, projectLogger, replanFoundation, logger, clock });
  const recovery = createBlockerRecovery({ store, validate, investigate: investigateStage, checkDisposition, resume, notify, clock, logger, ...limits, refreshWaiting: createBlockerReconciliationRefresh({ inspect, clock, projectLogger, readFailureEvidence, sprintRegistry, ticketStatusStore }) });
  const approvalRetry = createBlockerApprovalRetry({ inspect, checkpoints, eventBus, projectLogger, clock, readFailureEvidence });
  const capture = createBlockerCapture({ ticketStatusStore, checkpoints, sprintRegistry, architecturePlans, resolveTicketWorkspace, recovery, store, fileService, prepareRetry: approvalRetry.prepare, notifyRetry: approvalRetry.notify, logger, clock });
  const fulfillOwnerDecision = createBlockerOwnerHandoff({ store, recovery, checkpoints, ticketStatusStore, inspect, projectLogger });
  const prepareGovernance = createBlockerGovernanceHandoff({ plans, fileService: planFileService, projectId });
  eventBus.subscribe("*", async (event) => {
    if (event.type === "task.needs_human_review" && event.payload?.reason === "CODER_BLOCKED") await captureSafely(event.task_id, event);
  });
  return Object.freeze({ ...recovery, recover, stopTicket, resumeTicket, reconcileTicket, fulfillOwnerDecision, executionAdmission: admission.access, preflight: (request) => preflightBlockerContract(request,
    { sprintRegistry, architecturePlans, resolveTicketWorkspace, checkpoints, eventBus, projectLogger, agentOccupancy }) });

  // Recovers existing structured Coder blockers so an owner need not copy logs or reset tickets after deployment.
  async function recover() {
    for (const current of [...ticketStatusStore.listByStatus("needs_human_review"), ...ticketStatusStore.listByStatus("pending")]) {
      const taskId = current.ticket_id ?? current.task_id;
      const saved = await checkpoints.load(taskId);
      if (["owner_required", "owner_decided"].includes(saved?.blocker_recovery?.status) && blockerOwnerDecisions(saved, current).length) {
        try { await fulfillOwnerDecision({ projectId: current.project_id, ticketId: taskId }); }
        catch (error) { logger.error?.("Owner contract fulfillment needs reconciliation.", { task_id: taskId, code: error.code, error: error.message }); }
      } else await captureSafely(taskId);
    }
  }

  // Keeps one stale Sprint or storage fault from preventing other parked tickets and terminal events from progressing.
  async function captureSafely(taskId, event) {
    try { return await capture(taskId, event); }
    catch (error) { projectLogger({ event_name: "ticket.blocker_capture_failed", level: "error", status: "failed", task_id: taskId,
      message: "Automatic blocker intake failed; checkpoint retained for recovery.", payload: { code: error.code, error: error.message } }); return null; }
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

  // Gives each role current, Node-verified boundaries and criterion progress for remaining work.
  async function investigateStage(job, options) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Decision authority changed before investigation.");
    const ticket_progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore, reviewCheckpoint: await checkpoints.loadReview?.(job.request.task_id) });
    const contracts = await readBlockerContracts({ receipts: authority.checkpoint.contract_decisions, fileService, binding: { project_id: job.request.project_id, task_id: job.request.task_id, execution_id: job.request.payload.execution_id, sprint_basis: job.request.payload.sprint_basis } });
    ticket_progress.failure_classification = await classifyFailure(job, authority.workspace);
    ticket_progress.evidence_sha256 = blockerDigest([ticket_progress.evidence_sha256, ticket_progress.failure_classification]);
    await options.onTicketProgress?.(ticket_progress);
    if (ticket_progress.failure_classification?.category === "technical_failure") projectLogger({ event_name: "supervisor.blocker_failure_classified", level: "info", status: "success", task_id: job.request.task_id,
      message: "Node classified the retained access label as a technical failure from original receipts; SL coordinates recovery, tool approval remains enforced.",
      payload: { job_id: job.id, classification: ticket_progress.failure_classification } });
    const source = ticket_progress.source_reconciliation;
    if (source && job.technical_reconciliation?.work.kind === "source_revision") projectLogger({ event_name: "supervisor.blocker_source_evidence", level: "info", status: "success", task_id: job.request.task_id,
      message: "Node supplied ticket journal and current Git parent evidence to recovery; historical failed parent is not inferred.",
      payload: { job_id: job.id, revision: source.revision, parent_sha: source.parent_sha, observation_status: source.status,
        evidence_sha256: source.sha256, transaction_status: source.transaction.status,
        preexisting_paths: source.files.filter((entry) => entry.comparison === "preexisting_changes").map((entry) => entry.path), commit_scope: source.commit_scope } });
    const evidenceWork = job.waiting_work_history?.findLast((entry) => entry.owner === job.stage && entry.status === "assigned");
    if (evidenceWork) projectLogger({ event_name: "supervisor.blocker_waiting_evidence_assigned", level: "info", status: "started", task_id: job.request.task_id,
      message: `Missing blocker evidence assigned to ${job.stage}; read-only investigation, original Coder checkpoint retained.`,
      payload: { job_id: job.id, fingerprint: evidenceWork.fingerprint, owner: evidenceWork.owner, kind: evidenceWork.kind, request_id: evidenceWork.request_id ?? null } });
    if (job.technical_reconciliation && ["sprint_leader", "architecture_manager"].includes(job.stage)) projectLogger({ event_name: "supervisor.blocker_technical_follow_up", level: "info", status: "started", task_id: job.request.task_id,
      message: `${job.stage} is performing technical reconciliation round ${job.technical_reconciliation.round} in the same ticket.`,
      payload: { job_id: job.id, round: job.technical_reconciliation.round, prerequisite: job.technical_reconciliation.work.prerequisite } });
    await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: job.stage, status: "in_progress", details: { job_id: job.id }, logger, clock });
    const { objective, in_scope, out_of_scope, approach, acceptance_criteria } = authority.plan.content;
    return worker({ ...job, contract_context: blockerContractPrompt(contracts), ticket_progress, coder_checkpoint: { last_completed_turn: authority.checkpoint.last_completed_turn, changed_paths: authority.checkpoint.changed_paths,
      completed_tools: authority.checkpoint.completed_tools, turn_history: authority.checkpoint.turn_history }, owner_decisions: blockerOwnerDecisions({ ...authority.checkpoint, blocker_owner_decisions: [...(job.owner_decisions ?? []), ...(authority.checkpoint.blocker_owner_decisions ?? [])] }, authority.current), authority_context: { sprint: { objective, in_scope, out_of_scope, approach, acceptance_criteria }, architecture: authority.architecture,
      file_claims: await inspectBlockerFileClaims({ job, fileService }), passages: blockerAuthorityPassages({ plan: authority.plan, ticket: job.request.ticket, architecture: authority.architecture }) } }, options);
  }
  // Cancels stale authority while making a failed revalidation observable in the project audit.
  async function validate(job) {
    try { return Boolean(await inspect(job)); }
    catch (error) { logger.warn?.("Blocker authority could not be revalidated.", { task_id: job.request.task_id, code: error.code, error: error.message }); return false; }
  }

  // Verifies cached or fresh disposition evidence against the current approved plan and live source.
  async function checkDisposition(value, job, { retained = false } = {}) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Blocker authority changed during investigation.");
    const ticket_progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore, reviewCheckpoint: await checkpoints.loadReview?.(job.request.task_id) });
    ticket_progress.failure_classification = await classifyFailure(job, authority.workspace);
    ticket_progress.evidence_sha256 = blockerDigest([ticket_progress.evidence_sha256, ticket_progress.failure_classification]);
    if (retained && JSON.stringify(job.ticket_progress?.failure_classification ?? null) !== JSON.stringify(ticket_progress.failure_classification))
      throw blockerValidationError("/action", "failure_classification_changed", "Node's receipt-based failure classification changed. SL must reassess the current blocker before reusing this historical disposition.");
    const verified = await validateBlockerDisposition(value, { job: { ...job, ticket_progress }, plan: authority.plan, architecture: authority.architecture,
      fileService: (authority.workspace.root_only ? authority.workspace.fileService : authority.workspace.worktreeFileService ?? authority.workspace.fileService) ?? fileService,
      projectRoot: authority.workspace.path ?? authority.workspace.projectRoot, verifyContractSource: createTicketContractSource({ request: job.request, workspace: authority.workspace }) });
    if (["coder_requested", "candidate_prepared", "sprint_required"].includes(verified.action) || job.stage === "architecture_manager" && verified.action === "resolved") projectLogger({ event_name: "supervisor.blocker_candidate_handoff", level: "info", status: "success", task_id: job.request.task_id,
      message: job.stage === "architecture_manager" && verified.action === "resolved" ? "Architecture answer is ready for Sprint Leader; no Coder dispatch or execution approval." : verified.action === "sprint_required" ? "Architecture delegated implementation coordination to Sprint Leader; execution remains parked." : verified.action === "coder_requested" ? `${job.stage} requested a read-only Coder candidate; original execution remains parked.` : "Coder candidate is ready for its coordinating role; execution is not yet resumed.",
      payload: { job_id: job.id, action: verified.action, candidate_sha256: verified.candidate?.sha256 ?? null } });
    await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: job.stage, status: "completed", details: { job_id: job.id, action: verified.action }, logger, clock });
    return admission.prepare(verified, { ...job, ticket_progress });
  }

  // Resumes unchanged work under its original execution using the same transactional launch and review gates.
  async function resume(job) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Blocker source changed before resume.");
    const ticket_progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore, reviewCheckpoint: await checkpoints.loadReview?.(job.request.task_id) });
    ticket_progress.failure_classification = await classifyFailure(job, authority.workspace);
    ticket_progress.evidence_sha256 = blockerDigest([ticket_progress.evidence_sha256, ticket_progress.failure_classification]);
    const { current } = authority;
    const checkpoint = (await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: "coder", status: "resumed_from_blocker", details: { job_id: job.id }, logger, clock })) ?? authority.checkpoint;
    const resumed = { ...checkpoint, contract_decisions: await retainBlockerContract({ job, checkpoint, fileService }), status: "in_progress", phase: "blocker_resolved", blocker_recovery: {
      job_id: job.id, status: job.approval_retry ? "approval_retry" : "resolved", approval_retry: job.approval_retry ?? null,
      disposition: job.resolution, history: job.history, coder_exchange: job.coder_exchange ?? null, execution_admission: job.execution_admission ?? null, ticket_progress } };
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
      return await submitTicket({ ...job.request, required_role: job.request.required_role ?? job.request.ticket?.required_role ?? "coder", request_id: `BLOCKER-RESUME-${job.id}`,
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

  // Re-arms a cancelled or errored SL/AM stage at its recorded checkpoint position, auto-reconciling read-only unknown-provider stages on explicit RUN.
  async function resumeTicket({ projectId, ticketId }) {
    const current = ticketStatusStore.get(ticketId);
    if (current?.project_id !== projectId) throw new Error("Ticket belongs to a different project.");
    const checkpoint = await checkpoints.load(ticketId);
    const last = Array.isArray(checkpoint?.stage_progress) ? checkpoint.stage_progress.at(-1) : null;
    if (!checkpoint?.blocker_recovery || !["cancelled", "reconciliation_required"].includes(checkpoint.blocker_recovery.status)
      || (last && !["sprint_leader", "architecture_manager", "coder"].includes(last.stage))) throw new Error("Ticket has no resumable blocker recovery stage.");
    if (checkpoint.blocker_recovery.status === "reconciliation_required"
      && ["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(checkpoint.blocker_recovery.reason)) await reconcileTicket({ projectId, ticketId });
    const job = await recovery.resumeStage({ projectId, taskId: ticketId, executionId: current?.details?.execution_id, jobId: checkpoint.blocker_recovery.job_id });
    if (!job) throw Object.assign(new Error("Blocker stage cannot resume: the provider outcome is unknown or the ledger was replaced."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
    const claim = await agentOccupancy.getByTask?.(ticketId, job.history.at(-1)?.event === "sprint_recovery_assigned" ? job.history.at(-1).stage : job.stage);
    if (claim?.claim_id) await agentOccupancy.release({ claimId: claim.claim_id, taskId: ticketId, supervisorId: `BLOCKER-${job.id}`, reason: "blocker_stage_resumed" });
    const resumedCheckpoint = (await recordTicketStage({ checkpoints, taskId: ticketId, stage: job.stage, status: "in_progress", details: { job_id: job.id, resumed: true }, logger, clock })) ?? checkpoint;
    await checkpoints.save({ ...resumedCheckpoint, status: "blocked", phase: job.approval_retry ? "approval_retry_pending" : "blocker_triage_pending", blocker_recovery: { ...resumedCheckpoint.blocker_recovery, job_id: job.id, status: job.status, stage: job.stage, ...(job.approval_retry ? { approval_retry: job.approval_retry } : {}) } });
    if (job.approval_retry) await approvalRetry.notify(job, { force: true });
    return { ticket_id: ticketId, ...(current?.details?.execution_id ? { execution_id: current.details.execution_id } : {}), status: "accepted", pipeline: "supervisor", resumed: true, resumed_stage: job.stage, resumed_from_turn: checkpoint.last_completed_turn ?? 0, job_id: job.id };
  }

  // Reconciles a retained unknown-provider stage so a later RUN may re-arm it without an automatic provider replay.
  async function reconcileTicket({ projectId, ticketId, actor }) {
    const current = ticketStatusStore.get(ticketId);
    if (current?.project_id !== projectId) throw new Error("Ticket belongs to a different project.");
    const checkpoint = await checkpoints.load(ticketId);
    const parked = checkpoint?.blocker_recovery;
    if (checkpoint?.status !== "blocked" || parked?.status !== "reconciliation_required"
      || !["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(parked.reason)) throw new Error("Ticket has no unknown-provider blocker stage awaiting reconciliation.");
    const reconciled = await recovery.reconcileInterrupted({ projectId, taskId: ticketId, executionId: current?.details?.execution_id, jobId: parked.job_id });
    if (!reconciled) throw Object.assign(new Error("Blocker reconciliation ledger was replaced."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
    const claim = await agentOccupancy.getByTask?.(ticketId, reconciled.stage);
    if (claim?.claim_id) await agentOccupancy.release({ claimId: claim.claim_id, taskId: ticketId, supervisorId: `BLOCKER-${reconciled.id}`, reason: "blocker_provider_reconciled" });
    const reconciledCheckpoint = (await recordTicketStage({ checkpoints, taskId: ticketId, stage: reconciled.stage, status: "reconciled", details: { job_id: reconciled.id, reason: reconciled.outcome_reason }, logger, clock })) ?? checkpoint;
    await checkpoints.save({ ...reconciledCheckpoint, status: "blocked", phase: "blocker_reconciliation_required", blocker_recovery: { ...reconciledCheckpoint.blocker_recovery, status: "reconciliation_required", reason: reconciled.outcome_reason } });
    await eventBus.publish({ type: "task.blocker.reconciled", event_id: `BLOCKER-RECONCILED-${reconciled.id}`, task_id: ticketId, project_id: projectId,
      supervisor_id: `BLOCKER-${reconciled.id}`, request_id: `RECONCILE-${reconciled.id}`, correlation_id: `BLOCKER-${reconciled.id}-${reconciled.stage}`, attempt: 1,
      payload: { job_id: reconciled.id, stage: reconciled.stage, reason: reconciled.outcome_reason, execution_id: current?.details?.execution_id, execution_basis: current?.details?.execution_basis, actor: actor ?? null } });
    projectLogger({ event_name: "ticket.blocker_provider_reconciled", level: "info", status: "success", task_id: ticketId,
      message: `Reconciled an interrupted blocker provider stage; a subsequent RUN may re-arm it at the ${reconciled.stage} checkpoint.`,
      payload: { job_id: reconciled.id, stage: reconciled.stage, reason: reconciled.outcome_reason, actor: actor ?? null } });
    return { ticket_id: ticketId, status: "reconciled", job_id: reconciled.id, reconciled_stage: reconciled.stage };
  }
}
