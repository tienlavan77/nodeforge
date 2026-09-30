// nodeforge task integration - provides nodeforge task integration functionality for NodeForge.
import { ConfigurationError } from "../../shared/errors.js";
import { createAgentExecutionCheckpointStore } from "../agent/agent-execution-checkpoint.js";
import { createNodeforgeTaskExecutors } from "./nodeforge-task-executors.js";
import { createReviewWorker } from "./review-worker.js";
import { ensureReviewStatusReady } from "./review-only-status.js";
import { createTicketWorkspaceRuntime } from "./ticket-workspace-runtime.js";
import { completeApprovedTicket } from "./ticket-approved-integration.js";
import { selectDirectCoder, isOpenAiProfile, isCodexProfile, isOllamaProfile } from "./ticket-agent-provider-routing.js";
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
    const workspace = resolveTicketWorkspace ? await resolveTicketWorkspace(reviewTaskId) : null;
    const useWorkspace = workspace && (workspace.root_only ? (await workspace.gitService.assertAncestor(commit), true) : await workspace.gitService.getHead() === commit);
    const reviewGitService = useWorkspace ? workspace.gitService : gitService;
    const reviewWorker = useWorkspace ? createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService: workspace.worktreeFileService, gitService: workspace.gitService, codeCache: createCodeCacheService({ projectId: `${workspace.base_commit}:${workspace.branch}`, fileService: workspace.worktreeFileService, logger: projectLogger }), projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService, projectLogger }) : reviewer;
    const head = await reviewGitService?.getHead?.();
    if (!workspace?.root_only && head && head !== commit) throw Object.assign(new ConfigurationError(`Review-only commit is not the current checkout: ${commit}.`), { code: "REVIEW_COMMIT_NOT_CHECKED_OUT" });
    const paths = [...new Set(changed_paths ?? ["ui/nextjs/README.md"])];
    const reviewBase = base_commit ?? await reviewGitService?.getCommitParent?.(commit);
    const reviewOwnerId = `SUP-REVIEW-${reviewTaskId}`;
    const reviewProfile = agentResolver.resolveAvailable("reviewer");
    if (!reviewProfile) throw Object.assign(new ConfigurationError("No enabled and ready Reviewer is available."), { code: "REVIEWER_NOT_AVAILABLE" });
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
    ensureReviewStatusReady(ticketStatusStore, reviewTaskId);
    const outcomeType = result.verdict === "approved" ? "task.completed" : "task.needs_human_review";
    await publishTicketOutcome(outcomeType, { task_id: task_id ?? ticket.id, request_id: request_id ?? `REVIEW-${ticket.id}`, correlation_id: correlation_id ?? `CORR-REVIEW-${ticket.id}` }, `SUP-REVIEW-${ticket.id}`, { review_only: true, commit, verdict: result.verdict, findings: result.findings, reviewer_id: result.reviewer_id, evidence });
    return { task_id: task_id ?? ticket.id, commit, verdict: result.verdict, findings: result.findings, reviewer_id: result.reviewer_id, status: result.verdict === "approved" ? "approved" : "needs_human_review" };
  }
  async function submitTicket({ ticket, task_id, project_id, request_id, correlation_id, attempt = 1, payload = {}, required_role } = {}) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Node Supervisor ticket is required.");
    if (typeof agentResolver?.resolveAvailable !== "function") throw new ConfigurationError("NodeForge integration requires an agent resolver.");
    agentResolver.refresh?.();
    const taskId = task_id ?? ticket.id;
    const workspace = resolveTicketWorkspace ? await resolveTicketWorkspace(taskId) : null;
    const ticketRuntime = workspace ? createTicketWorkspaceRuntime({ workspace, gateways: { claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway }, agentResolver, runtimeGovernance, projectLogger, checkpoints, protocolStorage }) : { executors, reviewer };
    const standalone = payload.direct_code === true || Boolean(payload.tool_test);
    const reviewResume = payload.review_resume ?? null;
    const baseCommit = standalone ? null : reviewResume ? reviewResume.base_commit ?? workspace?.base_commit ?? null : workspace?.base_commit ?? payload.review_base_commit ?? await gitService?.getHead?.() ?? null;
    let selected = reviewResume
      ? agentResolver.list?.("coder")?.find((profile) => profile.agent_id === reviewResume.agent_id && profile.provider === reviewResume.provider && profile.enabled)
      : payload.direct_code === true ? selectDirectCoder(agentResolver, payload.resume_from) : agentResolver.resolveAvailable(required_role ?? ticket.required_role);
    const ownerId = supervisorManager.getByTask?.(taskId)?.supervisorId ?? `SUP-${taskId}`;
    const executionContext = await prepareTicketExecutionContext({ workspace, taskId, supervisorId: ownerId });
    let claim = null;
    if (agentOccupancy && (required_role ?? ticket.required_role) === "coder") {
      const existing = agentOccupancy.getByTask(taskId);
      const candidates = existing ? [existing.agent_id] : reviewResume ? [selected?.agent_id] : [selected?.agent_id, ...(agentResolver.list?.("coder") ?? []).filter((profile) => profile.enabled && profile.status === "ready").map((profile) => profile.agent_id)];
      for (const agentId of [...new Set(candidates.filter(Boolean))]) {
        if (payload.resume_from?.agent_id && agentId !== payload.resume_from.agent_id) continue;
        claim = await agentOccupancy.claim({ agentId, taskId, supervisorId: ownerId });
        if (claim) { selected = agentResolver.list?.("coder")?.find((profile) => profile.agent_id === agentId) ?? selected; break; }
      }
    }
    if (agentOccupancy && (required_role ?? ticket.required_role) === "coder" && !claim) throw Object.assign(new ConfigurationError("No unclaimed READY Coder is available."), { code: "AGENT_NOT_AVAILABLE" });
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
        result = await runSelected(selected, request, ticketRuntime.executors);
      }
    } catch (error) {
      await handleExecutionFailure(error, request, { selected, claim, taskId, ownerId });
      throw error;
    }
    projectLogger({ event_name: reviewResume ? "supervisor.review_resumed" : "supervisor.agent_execution_completed", level: "info", status: "success", message: reviewResume ? "Supervisor resumed review from completed Coder checkpoint." : "Agent completed execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, provider: selected.provider ?? null, ...(reviewResume ? { review_attempt: reviewResume.review_attempt } : { tool_events: result.tool_events }) } });
    if (claim && !standalone) {
      const limit = Math.max(0, Math.min(Number(ticket.execution_policy?.max_review_revisions ?? 2) || 0, 5));
      let reviewerClaim = null;
      for (let revision = reviewResume?.review_attempt ?? 0; ; revision += 1) {
        let verdict;
        const reviewCheckpoint = { task_id: taskId, status: "in_progress", phase: "review", reviewer_id: null, reviewer_name: null, provider: null, attempt: attempt + revision, review_attempt: revision, correlation_id: request.correlation_id, request_id: `${request.request_id}-REVIEW-${revision}`, coder_checkpoint_status: "completed", changed_paths: [], base_commit: baseCommit, verification: { coder_summary: result.summary, tool_events: result.tool_events }, findings: [], last_error: null };
        try {
          const checkpoint = await checkpoints?.load?.(taskId);
          const reviewedPaths = workspace ? Object.keys((await workspace.changeLedger.snapshot()).entries) : checkpoint?.changed_paths ?? [];
          const reviewedContext = workspace?.executionContexts ? await workspace.executionContexts.load(taskId) : null; const reviewEvidence = workspace ? await workspace.testService.assertPassedArtifact() : null;
          reviewCheckpoint.execution_context = reviewedContext; reviewCheckpoint.verification = reviewEvidence;
          await recordShadow("verification.passed", taskId, request, reviewEvidence);
          if (!ticketRuntime.reviewer) throw Object.assign(new ConfigurationError("Independent review is unavailable."), { code: "REVIEW_WORKER_UNAVAILABLE" });
          if (!reviewerClaim && agentOccupancy) {
            const existingReviewClaim = agentOccupancy.getByTask(taskId, "reviewer");
            const reviewerProfile = existingReviewClaim
              ? agentResolver.list?.("reviewer")?.find((profile) => profile.agent_id === existingReviewClaim.agent_id && profile.enabled)
              : agentResolver.resolveAvailable("reviewer");
            if (!reviewerProfile) throw Object.assign(new ConfigurationError("No enabled and ready Reviewer is available."), { code: "REVIEWER_NOT_AVAILABLE" });
            reviewerClaim = await agentOccupancy.claim({ agentId: reviewerProfile.agent_id, taskId, supervisorId: ownerId, role: "reviewer" });
            if (!reviewerClaim) throw Object.assign(new ConfigurationError("Reviewer is already working on another ticket."), { code: "REVIEWER_NOT_AVAILABLE" });
            projectLogger({ event_name: "supervisor.reviewer_claimed", level: "info", status: "started", message: "Supervisor claimed Reviewer for ticket review.", task_id: taskId, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: reviewCheckpoint.request_id, agent_id: reviewerProfile.agent_id, agent_name: reviewerProfile.agent_name, role: "reviewer", claim_id: reviewerClaim.claim_id } });
          }
          const claimedReviewer = reviewerClaim
            ? agentResolver.list?.("reviewer")?.find((profile) => profile.agent_id === reviewerClaim.agent_id)
            : agentResolver.resolveAvailable("reviewer");
          if (!claimedReviewer) throw Object.assign(new ConfigurationError("Claimed Reviewer profile is unavailable."), { code: "REVIEWER_NOT_AVAILABLE" });
          reviewCheckpoint.reviewer_id = claimedReviewer?.agent_id ?? null;
          reviewCheckpoint.reviewer_name = claimedReviewer?.agent_name ?? null;
          reviewCheckpoint.provider = claimedReviewer?.provider ?? null;
          reviewCheckpoint.changed_paths = reviewedPaths;
          await checkpoints?.saveReview?.(reviewCheckpoint);
          projectLogger({ event_name: "review.checkpoint_saved", level: "info", status: "started", message: "Reviewer checkpoint saved before SDK dispatch.", task_id: taskId, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: reviewCheckpoint.request_id, agent_id: reviewCheckpoint.reviewer_id, agent_name: reviewCheckpoint.reviewer_name, reviewer_id: reviewCheckpoint.reviewer_id, provider: reviewCheckpoint.provider, attempt: revision } });
          verdict = await ticketRuntime.reviewer.review({ task_id: taskId, correlation_id: request.correlation_id, request_id: `${request.request_id}-REVIEW-${revision}`, attempt: attempt + revision, agent_id: selected.agent_id, reviewer_id: reviewerClaim?.agent_id, payload: { ticket, execution_context: reviewedContext, changed_paths: reviewedPaths, base_commit: baseCommit, verification: reviewEvidence ?? { coder_summary: result.summary, tool_events: result.tool_events } } });
          if (workspace?.reviewFindings) await workspace.reviewFindings.recordReview({ verdict: verdict.verdict, findings: verdict.findings, artifactId: reviewEvidence.artifact_id, commitSha: reviewEvidence.commit_sha });
          await checkpoints?.completeReview?.(taskId, { ...reviewCheckpoint, status: "completed", verdict: verdict.verdict, findings: verdict.findings, reviewer_id: verdict.reviewer_id });
          if (verdict.verdict === "approved") await recordShadow("review.approved", taskId, request, { ...verdict, verification: reviewEvidence, reviewer_id: verdict.reviewer_id });
        } catch (error) {
          await checkpoints?.saveReview?.({ ...reviewCheckpoint, status: "failed", last_error: { code: error.code ?? "REVIEW_FAILED", message: error.message } });
          projectLogger({ event_name: "review.checkpoint_failed", level: "error", status: "failed", message: "Reviewer checkpoint recorded a failed review.", task_id: taskId, correlation_id: request.correlation_id, error_code: error.code ?? "REVIEW_FAILED", payload: { request_id: reviewCheckpoint.request_id, agent_id: reviewCheckpoint.reviewer_id, agent_name: reviewCheckpoint.reviewer_name, reviewer_id: reviewCheckpoint.reviewer_id } });
          projectLogger({ event_name: "supervisor.review_failed", level: "error", status: "failed", message: "Ticket review could not complete.", task_id: taskId, correlation_id: request.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "REVIEW_FAILED", payload: { error: error.message } });
          if (reviewerClaim) await agentOccupancy.release({ claimId: reviewerClaim.claim_id, taskId, supervisorId: ownerId, reason: "review_failed" });
          await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "review_unavailable" });
          await publishTicketOutcome("task.needs_human_review", request, ownerId, { reason: error.code ?? "REVIEW_FAILED" });
          return { task_id: taskId, request_id: request.request_id, agent_id: selected.agent_id, status: "needs_human_review", reason: error.code ?? "REVIEW_FAILED", response: result.summary, tool_events: result.tool_events };
        }
        if (verdict.verdict === "approved") {
          const blocked = await completeApprovedTicket({ workspace, reviewerClaim, agentOccupancy, coderClaim: claim, taskId, ownerId, request, projectLogger, publishTicketOutcome, selected, result });
          if (blocked) return blocked;
          break;
        }
        if (revision >= limit) {
          if (reviewerClaim) await agentOccupancy.release({ claimId: reviewerClaim.claim_id, taskId, supervisorId: ownerId, reason: "review_revision_limit" });
          await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "review_revision_limit" });
          await publishTicketOutcome("task.needs_human_review", request, ownerId, { reason: "review_revision_limit", findings: verdict.findings });
          return { task_id: taskId, request_id: request.request_id, agent_id: selected.agent_id, status: "needs_human_review", reason: "review_revision_limit", findings: verdict.findings, response: result.summary, tool_events: result.tool_events };
        }
        const requiredFindings = workspace?.reviewFindings ? await workspace.reviewFindings.unresolved() : verdict.findings;
        const revisionResume = { task_id: taskId, status: "in_progress", agent_id: selected.agent_id, provider: selected.provider, changed_paths: verdict.changed_paths, review_findings: requiredFindings, attempt: attempt + revision + 1, session_id: null, thread_id: null, last_completed_turn: 0, completed_tools: [], turn_history: [], read_cache: {}, coder_rules_read: false };
        const revised = { ...request, request_id: `${request.request_id}-REV-${revision + 1}`, attempt: attempt + revision + 1, payload: { ...request.payload, text: `${request.payload?.text ?? ticket.objective ?? ""}\nReviewer requested changes: ${requiredFindings.map((finding) => typeof finding === "string" ? finding : `${finding.finding_id}: ${finding.message}`).join("; ")}`, review_findings: requiredFindings, resume_from: revisionResume } };
        try {
          await checkpoints?.save?.(revisionResume);
          await handoffQueue.enqueue(revised);
        } catch (error) {
          if (reviewerClaim) await agentOccupancy.release({ claimId: reviewerClaim.claim_id, taskId, supervisorId: ownerId, reason: "revision_handoff_failed" });
          await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "revision_handoff_failed" });
          throw error;
        }
        try { result = await runSelected(selected, revised, ticketRuntime.executors); }
        catch (error) { if (reviewerClaim) await agentOccupancy.release({ claimId: reviewerClaim.claim_id, taskId, supervisorId: ownerId, reason: "coder_revision_failed" }); await handleExecutionFailure(error, revised, { selected, claim, taskId, ownerId }); throw error; }
      }
    }
    if (claim && standalone && payload.direct_code === true && workspace) {
      await workspace.integrate();
      await workspace.changeLedger.release();
    }
    if (claim && standalone) await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: payload.direct_code === true ? "direct_code_completed" : "tool_test_completed" });
    if (claim && !standalone) await publishTicketOutcome("task.completed", request, ownerId, { summary: result.summary });
    return { task_id: request.task_id, request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, status: "completed", job_id: queued?.id, response: result.summary, tool_events: result.tool_events };
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
    projectLogger({ event_name: "supervisor.tool_ticket_failed", level: "error", status: "failed", message: "Ticket execution failed.", task_id: failedRequest.task_id, correlation_id: failedRequest.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "TOOL_TICKET_FAILED", payload: { request_id: failedRequest.request_id, agent_id: selected?.agent_id, agent_name: selected?.agent_name, ...(error.tool ? { tool: error.tool } : {}), error: error.message } });
    if (!claim) return;
    const checkpoint = await checkpoints?.load?.(taskId);
    if (error.code === "COMMIT_APPROVAL_REJECTED") {
      await checkpoints?.save?.({ ...(checkpoint ?? { task_id: taskId }), status: "blocked", phase: "commit_approval", failure: { code: error.code, message: error.message, at: new Date().toISOString() } });
      await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "commit_approval_rejected" });
      await publishTicketOutcome("task.needs_human_review", failedRequest, ownerId, { reason: error.code });
      return;
    }
    if (!checkpoint || checkpoint.status === "completed") {
      await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason: "agent_failed_terminal" });
      if (failedRequest.payload?.direct_code !== true && !failedRequest.payload?.tool_test) await publishTicketOutcome("task.failed", failedRequest, ownerId, { error: { code: error.code ?? "TOOL_TICKET_FAILED", message: error.message } });
    }
    else projectLogger({ event_name: "agent.occupancy_retained", level: "info", status: "info", message: "Coder claim retained for a resumable checkpoint.", task_id: taskId, source: "nodeforge-task-integration", payload: { claim_id: claim.claim_id, checkpoint_status: checkpoint.status } });
  }

  // Sends only a reviewed or explicitly escalated ticket outcome to sprint orchestration.
  async function publishTicketOutcome(type, request, supervisorId, outcome) {
    await eventBus.publish({ type, task_id: request.task_id, supervisor_id: supervisorId, request_id: request.request_id, correlation_id: request.correlation_id, attempt: request.attempt ?? 1, payload: outcome });
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
