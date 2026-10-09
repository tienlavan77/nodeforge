// nodeforge task integration - provides nodeforge task integration functionality for NodeForge.
import { ConfigurationError } from "../../shared/errors.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { createAgentExecutionCheckpointStore } from "../agent/agent-execution-checkpoint.js";
import { createNodeforgeTaskExecutors } from "./nodeforge-task-executors.js";
import { createReviewWorker } from "./review-worker.js";
import { ensureReviewStatusReady } from "./review-only-status.js";
import { createTicketWorkspaceRuntime } from "./ticket-workspace-runtime.js";
import { completeCoderTicket } from "./ticket-coder-completion.js";
import { handleTicketExecutionFailure } from "./ticket-execution-failure.js";
import { selectTicketCoder, selectTicketReviewer, isOpenAiProfile, isCodexProfile, isOllamaProfile } from "./ticket-agent-provider-routing.js";
import { prepareTicketExecutionContext } from "./ticket-execution-context.js";
import { createCodeCacheService } from "../context/code-cache-service.js";
export { ticketCandidateScope } from "./nodeforge-task-scope.js";
// createNodeforgeTaskIntegration - handles createNodeforgeTaskIntegration operation.
export function createNodeforgeTaskIntegration({ supervisorManager, eventBus, agentResolver, agentOccupancy, ticketStatusStore, handoffQueue, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger = () => {}, fileService, gitService, checkpointStore, codeSearch, codeCache, relevantTreeSelector, protocolStorage, resolveTicketWorkspace, shadowComparison } = {}) {
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
    ? createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService, gitService, codeSearch, codeCache, projectRoot, projectLogger })
    : null;
  return Object.freeze({ startTask, submitTicket, reviewOnly });
  // Runs an independent Reviewer against an existing commit without dispatching or modifying the Coder.
  async function reviewOnly({ ticket, task_id, project_id, request_id, correlation_id, commit, base_commit, changed_paths, evidence = {}, coder_agent_id } = {}) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Review-only ticket is required.");
    if (!commit || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(commit)) throw new ConfigurationError("Review-only commit is required.");
    if (!reviewer) throw Object.assign(new ConfigurationError("Independent review is unavailable."), { code: "REVIEW_WORKER_UNAVAILABLE" });
    const reviewTaskId = task_id ?? ticket.id;
    const reviewExecution = ticketStatusStore?.get?.(reviewTaskId);
    const reviewPayload = reviewExecution?.details.execution_id ? { execution_id: reviewExecution.details.execution_id, sprint_basis: reviewExecution.details.execution_basis } : {};
    const workspace = resolveTicketWorkspace ? await resolveTicketWorkspace(reviewTaskId) : null;
    const useWorkspace = workspace && (workspace.root_only ? (await workspace.gitService.assertAncestor(commit), true) : await workspace.gitService.getHead() === commit);
    const reviewGitService = useWorkspace ? workspace.gitService : gitService;
    const reviewWorker = useWorkspace ? createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService: workspace.worktreeFileService, rulesFileService: fileService, gitService: workspace.gitService, codeCache: createCodeCacheService({ projectId: `${workspace.base_commit}:${workspace.branch}`, fileService: workspace.worktreeFileService, logger: projectLogger }), projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService, reviewFindings: workspace.reviewFindings, projectLogger }) : reviewer;
    const head = await reviewGitService?.getHead?.();
    if (!workspace?.root_only && head && head !== commit) throw Object.assign(new ConfigurationError(`Review-only commit is not the current checkout: ${commit}.`), { code: "REVIEW_COMMIT_NOT_CHECKED_OUT" });
    const paths = [...new Set(changed_paths ?? ["ui/nextjs/README.md"])];
    const reviewBase = base_commit ?? await reviewGitService?.getCommitParent?.(commit);
    const reviewOwnerId = `SUP-REVIEW-${reviewTaskId}`;
    const reviewProfile = selectTicketReviewer(agentResolver, ticket);
    const reviewClaim = await agentOccupancy?.claim?.({ agentId: reviewProfile.agent_id, taskId: reviewTaskId, supervisorId: reviewOwnerId, role: "reviewer" });
    if (agentOccupancy && !reviewClaim) throw Object.assign(new ConfigurationError("Reviewer is already working on another ticket."), { code: "REVIEWER_NOT_AVAILABLE" });
    let result;
    try {
      result = await reviewWorker.review({
        review_only: true, task_id: reviewTaskId, project_id, request_id: request_id ?? `REVIEW-${ticket.id}-${Date.now()}`,
        correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}-${Date.now()}`, agent_id: coder_agent_id ?? "review-only-coder", reviewer_id: reviewClaim?.agent_id,
        payload: { ticket, commit, base_commit: reviewBase, changed_paths: paths, verification: evidence }
      });
      if (useWorkspace) { const artifact = await workspace.testService.assertPassedArtifact(); await workspace.reviewFindings.recordReview({ verdict: result.verdict, findings: result.findings, artifactId: artifact.artifact_id, commitSha: artifact.commit_sha }); }
      const priorReview = await checkpoints?.loadReview?.(reviewTaskId);
      await checkpoints?.completeReview?.(reviewTaskId, {
        phase: "review", review_only: true, reviewer_id: result.reviewer_id, reviewer_name: reviewProfile.agent_name,
        provider: reviewProfile.provider, review_attempt: (priorReview?.review_attempt ?? 0) + 1,
        request_id: request_id ?? `REVIEW-${ticket.id}`, correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}`,
        changed_paths: paths, base_commit: reviewBase, commit, verdict: result.verdict, findings: result.findings, last_error: null
      });
    } finally {
      if (reviewClaim) await agentOccupancy.release({ claimId: reviewClaim.claim_id, taskId: reviewTaskId, supervisorId: reviewOwnerId, reason: "review_only_completed" });
    }
    if (result.verdict === "approved" && useWorkspace) { await workspace.integrate(); await workspace.changeLedger.release(); }
    if (reviewPayload.execution_id && !matchesTicketExecution(ticketStatusStore.get(reviewTaskId), reviewPayload.execution_id, reviewPayload.sprint_basis)) throw Object.assign(new ConfigurationError("Review completion belongs to an obsolete Ticket execution."), { code: "TICKET_EXECUTION_CONFLICT" });
    ensureReviewStatusReady(ticketStatusStore, reviewTaskId);
    const outcomeType = result.verdict === "approved" ? "task.completed" : "task.needs_human_review";
    await publishTicketOutcome(outcomeType, { task_id: task_id ?? ticket.id, project_id: project_id ?? ticket.project_id, payload: reviewPayload, request_id: request_id ?? `REVIEW-${ticket.id}`, correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}` }, `SUP-REVIEW-${ticket.id}`, { review_only: true, commit, verdict: result.verdict, findings: result.findings, reviewer_id: result.reviewer_id, evidence });
    return { task_id: task_id ?? ticket.id, commit, verdict: result.verdict, findings: result.findings, reviewer_id: result.reviewer_id, status: result.verdict === "approved" ? "approved" : "needs_human_review" };
  }
  async function submitTicket({ ticket, task_id, project_id, request_id, correlation_id, attempt = 1, payload = {}, required_role, abortSignal } = {}) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Node Supervisor ticket is required.");
    ticket = { ...ticket };
    delete ticket.candidate_files;
    delete ticket.candidates_produced_by;
    delete ticket.candidates_produced_at;
    if (typeof agentResolver?.resolveAvailable !== "function") throw new ConfigurationError("NodeForge integration requires an agent resolver.");
    agentResolver.refresh?.();
    const taskId = task_id ?? ticket.id;
    const workspace = resolveTicketWorkspace ? await resolveTicketWorkspace(taskId) : null;
    const ticketRuntime = workspace ? createTicketWorkspaceRuntime({ workspace, gateways: { claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway }, agentResolver, runtimeGovernance, projectLogger, checkpoints, protocolStorage }) : { executors, reviewer };
    const standalone = payload.direct_code === true || Boolean(payload.tool_test);
    const reviewResume = payload.review_resume ?? null;
    const baseCommit = standalone ? null : reviewResume ? reviewResume.base_commit ?? workspace?.base_commit ?? null : workspace?.base_commit ?? payload.review_base_commit ?? await gitService?.getHead?.() ?? null;
    const ownerId = supervisorManager.getByTask?.(taskId)?.supervisorId ?? `SUP-${taskId}`;
    const executionContext = await prepareTicketExecutionContext({ workspace, taskId, supervisorId: ownerId, ticket });
    const { selected, claim } = await selectTicketCoder({ resolver: agentResolver, occupancy: agentOccupancy, ticket, taskId, ownerId, role: required_role ?? ticket.required_role, payload });
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
      required_role: required_role ?? ticket.required_role,
      ticket,
      ...(executionContext ? { execution_context: executionContext } : {}),
      payload: baseCommit ? { ...payload, review_base_commit: baseCommit } : payload
    };
    let queued;
    try { if (!reviewResume) queued = await handoffQueue.enqueue(request); }
    catch (error) {
      if (claim) await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "handoff_failed" });
      throw error;
    }
    if (!reviewResume) projectLogger({ event_name: "supervisor.ticket_handoff", level: "info", status: "success", message: "Supervisor selected agent and queued handoff.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, job_id: queued?.id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role } });
    let result;
    try {
      if (reviewResume) {
        result = { summary: reviewResume.verification?.coder_summary ?? "Coder checkpoint completed before review resume.", tool_events: reviewResume.verification?.tool_events ?? [] };
      } else {
        projectLogger({ event_name: "supervisor.agent_execution_started", level: "info", status: "started", message: "Supervisor started Agent execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null } });
        if (abortSignal?.aborted) throw abortSignal.reason;
        result = await runSelected(selected, { ...request, abortSignal }, ticketRuntime.executors);
        if (abortSignal?.aborted) throw abortSignal.reason;
      }
    } catch (error) {
      await handleExecutionFailure(error, request, { selected, claim, taskId, ownerId });
      throw error;
    }
    const reported = result.tool_events?.some((event) => (event.name ?? event.tool) === "report_done" && event.status !== "failed");
    const explained = result.tool_events?.some((event) => (event.name ?? event.tool) === "respond_to_review" && event.status !== "failed");
    if (!reviewResume && (reported || explained)) await checkpoints?.complete?.(taskId, { phase: reported ? "coder_reported" : "coder_response_submitted", agent_id: selected.agent_id, provider: selected.provider });
    projectLogger({ event_name: reviewResume ? "supervisor.review_resumed" : "supervisor.agent_execution_completed", level: "info", status: "success", message: reviewResume ? "Supervisor resumed review from completed Coder checkpoint." : "Agent completed execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, provider: selected.provider ?? null, ...(reviewResume ? { review_attempt: reviewResume.review_attempt } : { tool_events: result.tool_events }) } });
    const completion = claim && !standalone ? await completeCoderTicket({ workspace, agentOccupancy, claim, taskId, ownerId, request, publishTicketOutcome, result }) : null;
    if (claim && standalone && payload.direct_code === true && workspace) {
      await workspace.integrate();
      await workspace.changeLedger.release();
    }
    if (claim && standalone) await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: payload.direct_code === true ? "direct_code_completed" : "tool_test_completed" });
    return { task_id: request.task_id, request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, status: completion?.status ?? "completed", job_id: queued?.id, response: result.summary, tool_events: result.tool_events };
  }
  // Dispatches a selected profile through its configured provider SDK for code and revisions.
  async function runSelected(selected, request, ticketExecutors = executors) {
    return isOpenAiProfile(selected) ? ticketExecutors.runOpenAiHello(selected, request)
      : isCodexProfile(selected) ? ticketExecutors.runCodexTask(selected, request)
        : isOllamaProfile(selected) ? ticketExecutors.runOllamaHello(selected, request)
          : ticketExecutors.runToolTicket(selected, request);
  }
  // Logs a failed attempt and releases only when no resumable checkpoint remains.
  async function handleExecutionFailure(error, failedRequest, { selected, claim, taskId, ownerId }) {
    return handleTicketExecutionFailure({ error, failedRequest, selected, claim, taskId, ownerId, checkpoints, agentOccupancy, projectLogger, publishTicketOutcome });
  }

  // Sends only a reviewed or explicitly escalated ticket outcome to sprint orchestration.
  async function publishTicketOutcome(type, request, supervisorId, outcome) {
    await eventBus.publish({ type, ...(request.project_id ? { project_id: request.project_id } : {}), task_id: request.task_id, supervisor_id: supervisorId, request_id: request.request_id, correlation_id: request.correlation_id, attempt: request.attempt ?? 1, payload: { ...outcome, ...(request.payload?.execution_id ? { execution_id: request.payload.execution_id, execution_basis: request.payload.sprint_basis } : {}) } });
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
