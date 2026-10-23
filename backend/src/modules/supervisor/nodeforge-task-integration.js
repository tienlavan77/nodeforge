// nodeforge task integration - provides nodeforge task integration functionality for NodeForge.
import { ConfigurationError } from "../../shared/errors.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { assertDependencySubmission } from "./ticket-dependency-expectations.js";
import { createAgentExecutionCheckpointStore } from "../agent/agent-execution-checkpoint.js";
import { createNodeforgeTaskExecutors } from "./nodeforge-task-executors.js";
import { createReviewWorker } from "./review-worker.js";
import { runReviewOnly } from "./review-only-task.js";
import { createTicketWorkspaceRuntime } from "./ticket-workspace-runtime.js";
import { completeCoderTicket } from "./ticket-coder-completion.js";
import { handleTicketExecutionFailure } from "./ticket-execution-failure.js";
import { selectTicketCoder, isOpenAiProfile, isCodexProfile, isOllamaProfile } from "./ticket-agent-provider-routing.js";
import { preflightBrowserVerification } from "./browser-verification-preflight.js";
import { prepareTicketExecutionContext } from "./ticket-execution-context.js";
import { prepareTicketReviewContext } from "./ticket-review-context.js";
import { releaseTicketAttempt } from "./ticket-attempt-release.js";
import { createTicketReviewRepair } from "./ticket-review-repair.js";
import { automaticReviewPolicy, bindAutomaticReviewCycle } from "./automatic-review-identity.js";
export { ticketCandidateScope } from "./nodeforge-task-scope.js";
// createNodeforgeTaskIntegration - handles createNodeforgeTaskIntegration operation.
export function createNodeforgeTaskIntegration({ supervisorManager, eventBus, agentResolver, agentOccupancy, ticketStatusStore, sprintRegistry, handoffQueue, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger = () => {}, fileService, gitService, checkpointStore, codeSearch, codeCache, relevantTreeSelector, protocolStorage, resolveTicketWorkspace, shadowComparison, automaticReview, coderRecovery, blockerRecovery } = {}) {
  if (typeof supervisorManager?.startTask !== "function" || typeof eventBus?.publish !== "function") throw new ConfigurationError("NodeForge integration requires Supervisor Manager and Event Bus.");
  if (typeof handoffQueue?.enqueue !== "function") throw new ConfigurationError("NodeForge integration requires a sender handoff queue.");
  const checkpoints = checkpointStore ?? (fileService ? createAgentExecutionCheckpointStore({ fileService }) : null);
  const publishedOwners = new Set();
  const executors = createNodeforgeTaskExecutors({
    claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry,
    runtimeGovernance, projectRoot, projectLogger, checkpoints, relevantTreeSelector,
    protocolStorage, fileService
  });
  const reviewer = typeof agentResolver?.resolveAvailable === "function" && fileService?.readForIndex
    ? createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService, gitService, codeSearch, codeCache, projectRoot, checkpoints, projectLogger })
    : null;
  // Exposes independent review while keeping its execution and evidence checks in one service.
  const reviewOnly = (input) => runReviewOnly(input, { reviewer, ticketStatusStore, resolveTicketWorkspace, gitService, fileService, agentResolver,
    claudeSdkGateway, openaiSdkGateway, codexSdkGateway, codeSearch, checkpoints, projectLogger, agentOccupancy, publishTicketOutcome });
  return Object.freeze({ startTask, submitTicket, reviewOnly });
  async function submitTicket({ ticket, task_id, project_id, request_id, correlation_id, attempt = 1, payload = {}, required_role, abortSignal } = {}) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Node Supervisor ticket is required.");
    ticket = { ...ticket };
    delete ticket.candidate_files;
    delete ticket.candidates_produced_by;
    delete ticket.candidates_produced_at;
    if (typeof agentResolver?.resolveAvailable !== "function") throw new ConfigurationError("NodeForge integration requires an agent resolver.");
    agentResolver.refresh?.();
    const taskId = task_id ?? ticket.id;
    payload = payload.dependency_expectations === undefined ? payload : structuredClone(payload);
    assertDependencySubmission({ projectId: project_id ?? ticket.project_id, ticket, payload, sprintRegistry, ticketStatusStore });
    if (!payload.review_resume) await preflightBrowserVerification(ticket.verification_plan, { projectRoot });
    const workspace = resolveTicketWorkspace ? await resolveTicketWorkspace(taskId) : null;
    payload = bindAutomaticReviewCycle({ payload }, await workspace?.executionContexts?.load?.(taskId)).payload;
    assertDependencySubmission({ projectId: project_id ?? ticket.project_id, ticket, payload, sprintRegistry, ticketStatusStore });
    const ticketRuntime = workspace ? createTicketWorkspaceRuntime({ workspace, gateways: { claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway }, agentResolver, runtimeGovernance, projectLogger, checkpoints, protocolStorage }) : { executors, reviewer };
    const standalone = payload.direct_code === true || Boolean(payload.tool_test);
    if (!standalone) automaticReviewPolicy(ticket, { blocking: Boolean(payload.review_cycle_id) });
    if (!standalone && ticket.execution_policy?.requires_existing_contract && !blockerRecovery) throw Object.assign(new ConfigurationError("Declared contract prerequisites require automatic blocker recovery."), { code: "BLOCKER_RECOVERY_UNAVAILABLE" });
    if (!standalone && automaticReviewPolicy(ticket, { blocking: Boolean(payload.review_cycle_id) }).gate === "on" && (!automaticReview || !workspace || !agentOccupancy)) throw Object.assign(new ConfigurationError("Hard review requires durable ticket evidence and independent occupancy."), { code: "REVIEW_WORKER_UNAVAILABLE" });
    const reviewResume = payload.review_resume ?? null;
    const baseCommit = standalone ? null : reviewResume ? reviewResume.base_commit ?? workspace?.base_commit ?? null : workspace?.base_commit ?? payload.review_base_commit ?? await gitService?.getHead?.() ?? null;
    const ownerId = supervisorManager.getByTask?.(taskId)?.supervisorId ?? `SUP-${taskId}`;
    if (!reviewResume && payload.resume_from?.review_repair_key && workspace?.beginFindingRepair) {
      await workspace.beginFindingRepair(payload.resume_from.review_repair_key);
    }
    // An owner-approved governed successor (automatic foundation split) may have integrated content
    // that legitimately replaces this ticket's recorded baseline; rebase before any ledger snapshot.
    const integratedSuccessors = workspace?.root_only && !standalone && !reviewResume ? await approvedIntegratedSuccessors(taskId) : [];
    if (integratedSuccessors.length) {
      try { await workspace.changeLedger.resume({ integrated_successors: integratedSuccessors }); }
      catch (error) {
        await workspace.changeLedger.release({ close: false }).catch(() => {});
        projectLogger({ event_name: "ticket.baseline_rebase_failed", level: "error", status: "failed", message: error.message, task_id: taskId, source: "nodeforge-task-integration", error_code: error.code ?? "TICKET_BASELINE_REBASE_FAILED", payload: { successor_ids: integratedSuccessors } });
        throw error;
      }
    }
    const executionContext = reviewResume
      ? await prepareTicketReviewContext({ workspace, taskId, supervisorId: ownerId, ticket, resume: reviewResume })
      : await prepareTicketExecutionContext({ workspace, taskId, supervisorId: ownerId, ticket });
    if (payload.retry_source_identity && ["source_revision", "manifest_sha", "review_commit_sha", "base_sha"].some((field) => executionContext?.[field] !== payload.retry_source_identity[field])) throw Object.assign(new ConfigurationError("Coder retry source changed during preparation."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    if (!standalone && !reviewResume && blockerRecovery && await blockerRecovery.preflight({ ticket, task_id: taskId, project_id: project_id ?? ticket.project_id,
      request_id: request_id ?? `REQ-${taskId}`, correlation_id: correlation_id ?? `CORR-${taskId}`, supervisor_id: ownerId,
      execution_context: executionContext, payload })) return { task_id: taskId, supervisor_id: ownerId, status: "needs_human_review" };
    assertDependencySubmission({ projectId: project_id ?? ticket.project_id, ticket, payload, sprintRegistry, ticketStatusStore });
    const effectiveRole = required_role ?? ticket.required_role ?? "coder";
    const { selected, claim } = await selectTicketCoder({ resolver: agentResolver, occupancy: agentOccupancy, ticket, taskId, ownerId, role: effectiveRole, payload });
    if (!selected) throw Object.assign(new ConfigurationError("No enabled and ready Agent Profile is available."), { code: "AGENT_NOT_AVAILABLE" });
    const request = {
      task_id: task_id ?? ticket.id,
      project_id: project_id ?? ticket.project_id,
      request_id: request_id ?? `REQ-${task_id ?? ticket.id}`,
      correlation_id: correlation_id ?? `CORR-${task_id ?? ticket.id}`,
      attempt,
      agent_id: selected.agent_id,
      selected_agent_id: selected.agent_id,
      selected_agent_name: selected.agent_name,
      selected_agent_role: selected.role,
      ...(claim ? { claim_id: claim.claim_id, supervisor_id: ownerId } : {}),
      required_role: effectiveRole,
      ticket,
      ...(executionContext ? { execution_context: executionContext } : {}),
      payload: baseCommit ? { ...payload, review_base_commit: baseCommit } : payload
    };
    let queued;
    try {
      assertDependencySubmission({ projectId: request.project_id, ticket, payload: request.payload, sprintRegistry, ticketStatusStore });
      if (!reviewResume) await workspace?.changeLedger?.resume?.({ integrated_successors: integratedSuccessors });
      if (!reviewResume) queued = await handoffQueue.enqueue(request);
    }
    catch (error) {
      await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "handoff_failed" });
      throw error;
    }
    if (!reviewResume) projectLogger({ event_name: "supervisor.ticket_handoff", level: "info", status: "success", message: "Supervisor selected agent and queued handoff.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, job_id: queued?.id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role } });
    let result; let launchReceipt;
    try {
      assertDependencySubmission({ projectId: request.project_id, ticket, payload: request.payload, sprintRegistry, ticketStatusStore });
      if (reviewResume) {
        result = { summary: reviewResume.verification?.coder_summary ?? "Coder checkpoint completed before review resume.", tool_events: reviewResume.verification?.tool_events ?? [] };
      } else {
        projectLogger({ event_name: "supervisor.agent_launch_intent", level: "info", status: "pending", message: "Supervisor intends to dispatch Agent execution; launch ownership and provider invocation are not yet witnessed.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null } });
        if (abortSignal?.aborted) throw abortSignal.reason;
        if (request.payload.dependency_expectations !== undefined) {
          launchReceipt = ticketStatusStore.claimExecutionLaunch(taskId, { executionId: request.payload.execution_id, basis: request.payload.sprint_basis,
            requestId: request.request_id, jobId: queued.id, supervisorId: ownerId, agentId: selected.agent_id, claimId: claim?.claim_id,
            validate: () => assertDependencySubmission({ projectId: request.project_id, ticket, payload: request.payload, sprintRegistry, ticketStatusStore }) });
        }
        projectLogger({ event_name: "supervisor.agent_dispatch_boundary", level: "info", status: "dispatching", message: "Supervisor reached the local executor call boundary; this is not provider acknowledgement or completion.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, execution_id: launchReceipt?.execution_id, job_id: queued?.id, agent_id: selected.agent_id, launch_claimed: Boolean(launchReceipt), provider_acknowledged: false } });
        result = await runSelected(selected, { ...request, abortSignal }, ticketRuntime.executors);
        if (launchReceipt) {
          if (!["running", "reviewing"].includes(ticketStatusStore.get(taskId)?.status)) throw Object.assign(new ConfigurationError("Ticket execution ended before Coder finalization."), { code: "TICKET_STOPPED" });
          await handoffQueue.ack(queued.id);
          ticketStatusStore.reconcileExecutionLaunch(taskId, { executionId: launchReceipt.execution_id, requestId: request.request_id, jobId: queued.id, disposition: "executor_returned" });
        }
        if (abortSignal?.aborted) throw abortSignal.reason;
      }
    } catch (error) {
      if (error.launch_claim_conflict) throw error;
      if (request.payload.execution_id && !matchesTicketExecution(ticketStatusStore?.get?.(taskId), request.payload.execution_id, request.payload.sprint_basis)) throw error;
      if (queued && request.payload.dependency_expectations !== undefined) {
        try { await handoffQueue.quarantine(queued.id, { requestId: request.request_id, reason: error.code ?? "execution_reconciliation_required" }); }
        catch (reconciliationError) {
          error.reconciliation_error = reconciliationError.code ?? reconciliationError.message;
          projectLogger({ event_name: "supervisor.handoff_reconciliation_failed", level: "error", status: "failed", message: "Handoff disposition could not be persisted; do not redispatch this execution.", task_id: taskId, source: "nodeforge-task-integration", payload: { request_id: request.request_id, job_id: queued.id, error: reconciliationError.message } });
        }
      }
      if (launchReceipt && (error.code === "PROVIDER_UNKNOWN" || error.provider_outcome === "unknown" || error.reconciliation_error)) {
        projectLogger({ event_name: "supervisor.agent_outcome_unknown", level: "error", status: "blocked", message: "Claimed execution failed without reconciled provider disposition; retain ownership and do not retry or replace.", task_id: taskId, source: "nodeforge-task-integration", payload: { request_id: request.request_id, execution_id: launchReceipt.execution_id, job_id: queued?.id, cause_code: error.code ?? "PROVIDER_OUTCOME_UNKNOWN" } });
        throw Object.assign(new ConfigurationError("Provider outcome for the claimed execution requires reconciliation before retry or replacement."), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409, retryable: false, scope: "scoped", identifiers: [taskId], cause: error });
      }
      if (launchReceipt) ticketStatusStore.reconcileExecutionLaunch(taskId, { executionId: launchReceipt.execution_id, requestId: request.request_id, jobId: queued.id, disposition: "executor_failed" });
      if (coderRecovery && workspace) request.execution_context = await workspace.executionContexts.load(taskId);
      await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "ticket_execution_failed" });
      const recovery = await handleExecutionFailure(error, request, { selected, claim, taskId, ownerId });
      if (recovery?.handled) return { task_id: taskId, supervisor_id: ownerId, status: "recovery_pending", recovery: recovery.outcome };
      throw error;
    }
    try {
      const reported = result.tool_events?.some((event) => (event.name ?? event.tool) === "report_done" && event.status !== "failed");
      const explained = result.tool_events?.some((event) => (event.name ?? event.tool) === "respond_to_review" && event.status !== "failed");
      if (!reviewResume && (reported || explained)) await checkpoints?.complete?.(taskId, { phase: reported ? "coder_reported" : "coder_response_submitted", agent_id: selected.agent_id, provider: selected.provider });
      projectLogger({ event_name: reviewResume ? "supervisor.review_resumed" : "supervisor.agent_execution_returned", level: "info", status: "info", message: reviewResume ? "Supervisor resumed review from completed Coder checkpoint." : "Agent returned; ticket verification and integration are pending.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, provider: selected.provider ?? null, ...(reviewResume ? { review_attempt: reviewResume.review_attempt } : { tool_events: result.tool_events }) } });
      const completion = claim && !standalone ? await completeCoderTicket({ workspace, agentOccupancy, claim, taskId, ownerId, request, publishTicketOutcome, result, automaticReview, checkpoints, projectLogger,
        runRepair: createTicketReviewRepair({ workspace, taskId, ownerId, ticket, selected, checkpoints, handoffQueue, ticketStatusStore, sprintRegistry, abortSignal, projectLogger, execute: (repaired) => runSelected(selected, repaired, ticketRuntime.executors) }) }) : null;
      if (claim && standalone && payload.direct_code === true && workspace) {
        await workspace.integrate();
        await workspace.changeLedger.release();
      }
      if (claim && standalone) await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: payload.direct_code === true ? "direct_code_completed" : "tool_test_completed" });
      const status = completion?.status ?? "completed";
      if (status === "completed") projectLogger({ event_name: "supervisor.agent_execution_completed", level: "info", status: "success", message: "Agent execution completed after applicable verification and integration checks.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, provider: selected.provider ?? null } });
      return { task_id: request.task_id, request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, status, job_id: queued?.id, response: result.summary, tool_events: result.tool_events };
    } catch (error) {
      const current = ticketStatusStore?.get?.(taskId);
      if (!current || ["running", "reviewing"].includes(current.status) && (!request.payload.execution_id || matchesTicketExecution(current, request.payload.execution_id, request.payload.sprint_basis))) {
        await releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason: "ticket_completion_failed" });
        await handleExecutionFailure(error, error.failed_request ?? request, { selected, claim, taskId, ownerId });
      }
      throw error;
    }
  }
  // Dispatches a selected profile through its configured provider SDK for code and revisions.
  async function runSelected(selected, request, ticketExecutors = executors) {
    return isOpenAiProfile(selected) ? ticketExecutors.runOpenAiHello(selected, request)
      : isCodexProfile(selected) ? ticketExecutors.runCodexTask(selected, request)
        : isOllamaProfile(selected) ? ticketExecutors.runOllamaHello(selected, request)
          : ticketExecutors.runToolTicket(selected, request);
  }
  // Lists a governed successor only when the project owner's recorded decision names it for this source ticket.
  async function approvedIntegratedSuccessors(taskId) {
    if (!checkpoints?.load) return [];
    let checkpoint;
    try { checkpoint = await checkpoints.load(taskId); } catch (error) { projectLogger({ event_name: "ticket.checkpoint_read_skipped", level: "debug", status: "skipped", message: error.message, task_id: taskId, source: "nodeforge-task-integration" }); return []; }
    const recovery = checkpoint?.blocker_recovery;
    const replan = recovery?.foundation_replan;
    if (!recovery?.owner_decision || !replan?.ticket_id || replan.source_ticket_id !== taskId || replan.dispatched !== true) return [];
    return [replan.ticket_id];
  }
  // Logs an ended attempt's failure while preserving checkpoints and releasing occupancy.
  async function handleExecutionFailure(error, failedRequest, { selected, claim, taskId, ownerId }) {
    return handleTicketExecutionFailure({ error, failedRequest, selected, claim, taskId, ownerId, checkpoints, agentOccupancy, projectLogger, publishTicketOutcome, coderRecovery });
  }
  // Sends only a reviewed or explicitly escalated ticket outcome to sprint orchestration.
  async function publishTicketOutcome(type, request, supervisorId, outcome) {
    await eventBus.publish({ type, ...(outcome.event_id ? { event_id: outcome.event_id } : {}), ...(request.project_id ? { project_id: request.project_id } : {}), task_id: request.task_id, supervisor_id: supervisorId, request_id: request.request_id, correlation_id: request.correlation_id, attempt: request.attempt ?? 1, payload: { ...outcome, ...(request.payload?.execution_id ? { execution_id: request.payload.execution_id, execution_basis: request.payload.sprint_basis } : {}) } });
    if (type === "task.completed") await recordShadow(type, request.task_id, request, outcome);
  }
  // Records direct integration events in shadow mode when the inline ticket path bypasses the event bus.
  async function recordShadow(type, taskId, request, payload) {
    if (!shadowComparison?.compare) return;
    await shadowComparison.compare({ event_id: `SHADOW-${type}-${taskId}-${request.request_id ?? "request"}`, type, task_id: taskId, supervisor_id: request.supervisor_id ?? `SUP-${taskId}`, request_id: request.request_id, correlation_id: request.correlation_id, payload });
  }
  async function startTask({ task_id, project_id, request_id, correlation_id, attempt = 1, request = {}, payload, ticket, relevantTree = [], restart = false } = {}) {
    const runtime = await supervisorManager.startTask({ task_id, project_id, request_id, correlation_id, attempt, payload, ticket, relevantTree, restart });
    if (runtime.ownershipCreated && !publishedOwners.has(runtime.supervisorId)) {
      publishedOwners.add(runtime.supervisorId);
      await eventBus.publish({ type: "task.started", task_id, supervisor_id: runtime.supervisorId, request_id: request_id ?? `REQ-${task_id}`, correlation_id: correlation_id ?? `CORR-${task_id}`, attempt, payload: { project_id, request, relevantTree, ticket, ...(payload ? { payload } : {}) } });
    }
    return { task_id, supervisor_id: runtime.supervisorId, status: runtime.ownershipCreated || restart || runtime.wasReset ? "started" : "already_running" };
  }
}
