import process from "node:process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";

process.chdir(resolve(process.env.NODE_CONTROL_PROJECT_ROOT ?? new URL("../..", import.meta.url).pathname));
loadNodeforgeEnv();

import { createArchitectureWorkspaceService } from "../src/application/architecture-workspace-service.js";
import { createProjectDashboardService } from "../src/application/project-dashboard-service.js";
import { createConversationAuditHistoryService } from "../src/application/conversation-audit-history-service.js";
import { createHumanDecisionService } from "../src/application/human-decision-service.js";
import { createGitService } from "../src/infrastructure/git/git-service.js";
import { createUnifiedStreamOrderer } from "../src/modules/events/unified-stream-order.js";
import { logEvent, readLogEvents } from "../src/core/project-log-service.js";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createUnifiedStreamPublisher } from "./control-api-unified-stream.mjs";
import { startControlApi } from "./control-api-lifecycle.mjs";
import { createBuilderContext } from "./control-api-builder-context.mjs";
import { createOnWriteVerifier } from "./control-api-file-verification.mjs";
import { createControlApiAgent } from "./control-api-agent.mjs";
import { createControlApiPlatform } from "./control-api-platform.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createControlApiHttp } from "./control-api-http.mjs";
import { createProductionSupervisorRuntime } from "../src/modules/supervisor/production-runtime.js";
import { createTerminalBridge } from "../src/modules/supervisor/terminal-bridge.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { createSprintDagRunner } from "../src/modules/supervisor/sprint-dag.js";
import { createSprintRunDispatch } from "../src/application/sprint-run-dispatch.js";
import { createCompletionReportService } from "../src/modules/supervisor/completion-report-service.js";
import { createEvalCaseRecorder } from "../src/modules/eval/eval-case-store.js";
import { createTicketCrudService } from "../src/application/ticket-crud-service.js";
import { createDirectCodeRequest } from "../src/application/direct-code-request.js";
import { createCodeCacheService } from "../src/modules/context/code-cache-service.js";
import { createAgentOccupancyStore } from "../src/modules/agent/agent-occupancy-store.js";
import { createTicketWorkspaceService } from "../src/modules/supervisor/ticket-workspace-service.js";
import { withTicketProjectCommitLock } from "../src/modules/supervisor/ticket-project-commit-lock.js";
import { createTicketPipelineInventory } from "../src/modules/supervisor/ticket-pipeline-inventory.js";
import { createTicketPipelineRollout } from "../src/modules/supervisor/ticket-pipeline-rollout.js";
import { createTicketPipelineShadow } from "../src/modules/supervisor/ticket-pipeline-shadow.js";
import { createTicketPipelineDisposition } from "../src/modules/supervisor/ticket-pipeline-disposition.js";
import { createHumanPlanStore } from "../src/modules/governance/human-plan-store.js";
import { createMarkdownPlanStore } from "../src/modules/governance/markdown-plan-store.js";
import { createSprintRegistry } from "../src/modules/governance/sprint-registry.js";
import { createPlanOwnerAuth } from "../src/modules/governance/plan-owner-auth.js";
import { createApprovedTicketDispatch } from "../src/application/approved-ticket-dispatch.js";
import { createSprintPlanDraftPersistence } from "../src/modules/governance/sprint-plan-draft-persistence.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { migrateConversationErrors } from "../src/modules/governance/conversation-error-migration.js";
import { createSprintLeaderIntakeService } from "../src/application/sprint-leader-intake-service.js";
import { createTicketHumanReviewService } from "../src/application/ticket-human-review-service.js";
import { createTicketRunDispatch } from "../src/application/ticket-run-dispatch.js";
import { reviewPhaseResume } from "../src/modules/supervisor/review-revision-resume.js";

const config = readControlApiConfig();
const { port, host } = config;
let testService;
const storage = await createControlApiStorage({
  config,
  onWrite: createOnWriteVerifier({ getTestService: () => testService })
});
const { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb } = storage;
const database = controlDb;
const { profiles, agentConfiguration, agentGateway, claudeSdkGateway, codexSdkGateway, openaiSdkGateway, ollamaSdkGateway, agentSettings, agentRoleResolver } = createControlApiAgent({ database, fileService, config });
const planFileService = createFileService({ projectRoot: config.cwd, allowPlanStorage: true });
const markdownPlanStore = createMarkdownPlanStore({ projectId: config.projectId, database, fileService: planFileService });
const planStore = createHumanPlanStore({ projectId: config.projectId, database, fileService: planFileService, markdownPlans: markdownPlanStore });
const sprintRegistry = createSprintRegistry({ projectId: config.projectId, database, plans: planStore });
const planOwnerAuth = createPlanOwnerAuth({ token: process.env.NODEFORGE_PLAN_OWNER_TOKEN, ownerId: process.env.NODEFORGE_PLAN_OWNER_ID });
const draftPlan = createSprintPlanDraftPersistence({ projectId: config.projectId, planStore, markdownPlanStore, sprintRegistry });
const platform = createControlApiPlatform({ config, database, indexDb, fileService, agentGateway, claudeSdkGateway, codexSdkGateway, openaiSdkGateway, agentRoleResolver, logEvent, draftPlan });
await migrateConversationErrors({ database, fileService, projectId: config.projectId });
const gitService = createGitService({ projectRoot: config.cwd, mutationLock: (action) => withTicketProjectCommitLock({ fileService, projectId: platform.projectId }, action) });
const reportService = createCompletionReportService({ protocolStorage, fileService, gitService });
const onEvalCase = createEvalCaseRecorder({ root: config.cwd });
const { projectId, indexDb: platformIndexDb, codeSearch, fileGraph, relevantTreeSelector, freshnessChecker, ticketSprintLeader, sprintPlanLeader, communications, conversations, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, contextEngine, sprintOrchestration, proseTicketService, ticketFileStore, sprintPlanUpload, taskSummaries, projectMemory } = platform;
const agentOccupancy = createAgentOccupancyStore({ database, profiles, configuration: agentConfiguration, logger: { error: (_message, details) => logEvent({ timestamp: new Date().toISOString(), event_name: "agent.occupancy_notification_failed", level: "error", status: "failed", message: "Agent occupancy post-commit notification failed.", task_id: details.task_id, project_id: projectId, source: "agent-occupancy-store", error_code: "OCCUPANCY_NOTIFICATION_FAILED", payload: details }) }, onChanged: async (claim) => {
  const timestamp = new Date().toISOString();
  const event = { event_id: `EVT-${randomUUID()}`, type: "agent.status_changed", project_id: projectId, timestamp, task_id: claim.task_id, agent_id: claim.agent_id, payload: { agent_id: claim.agent_id, status: claim.status, previous_status: claim.previous_status, task_id: claim.task_id, supervisor_id: claim.supervisor_id, claim_id: claim.claim_id, reason: claim.release_reason ?? null, updated_at: timestamp }, metadata: { project_id: projectId, source: "agent-occupancy-store" } };
  internalBus.emit("agent.status_changed", event);
  await eventPublisher.publish(event);
} });
testService = platform.testService;
const unifiedStreamOrder = createUnifiedStreamOrderer();
const runtimeLogger = createRuntimeLogger({ logEvent });
const codeCache = createCodeCacheService({ projectId, fileService, codeSearch, logger: runtimeLogger.emit });
const ticketWorkspaceService = createTicketWorkspaceService({ projectRoot: config.cwd, projectId, protocolStorage, stateFileService: fileService, indexDatabase: indexDb, codeSearch, fileGraph, codeCache, rootOnly: process.env.NODEFORGE_TICKET_EXECUTION_MODE === "root-only", projectLogger: runtimeLogger.emit });
const ticketPipelineInventory = createTicketPipelineInventory({ projectRoot: config.cwd, projectId, fileService });
const ticketPipelineDisposition = createTicketPipelineDisposition({ projectId, fileService, inventory: ticketPipelineInventory, projectLogger: runtimeLogger.emit });
const ticketPipelineRollout = createTicketPipelineRollout({ projectId, fileService, inventory: ticketPipelineInventory, disposition: ticketPipelineDisposition, projectLogger: runtimeLogger.emit });
const ticketPipelineShadow = createTicketPipelineShadow({ projectId, fileService, rollout: ticketPipelineRollout, projectLogger: runtimeLogger.emit });
let ticketPipelineMode = await ticketPipelineRollout.load();
if (ticketPipelineMode.version === 0) ticketPipelineMode = await ticketPipelineRollout.setMode("shadow", 0);
if (ticketPipelineMode.mode === "shadow") {
  try { await ticketPipelineRollout.shadowAudit(); }
  catch (error) { runtimeLogger.emit({ event_name: "ticket.pipeline_shadow_audit_failed", level: "error", status: "failed", message: "Ticket pipeline inventory audit failed; existing workspace gates remain active.", source: "control-api", error_code: error.code ?? "TICKET_PIPELINE_AUDIT_FAILED", payload: { error: error.message } }); }
}
const buildBuilderContext = createBuilderContext({ roadmaps, indexDb, contextEngine });
const supervisorRuntime = createProductionSupervisorRuntime({ projectRoot: config.cwd, fileService, root: ".forge/runtime", eventStore, agentGateway, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, agentRoleResolver, agentOccupancy, ticketStatusStore, sprintRegistry, codeSearch, codeCache, relevantTreeSelector, freshnessChecker, logger: runtimeLogger, projectLogger: runtimeLogger.emit, projectId,
  checkpointSaved: async (checkpoint) => {
    if (!checkpoint.task_id?.startsWith("CODE-")) return;
    try {
      const input = JSON.parse(await fileService.readFile({ path: `.forge/runtime/nf/code-requests/${checkpoint.task_id}.json` }));
      internalBus.emit("agent.checkpoint.updated", { type: "agent.checkpoint.updated", project_id: input.project_id, payload: { task_id: checkpoint.task_id, sprint_id: input.sprint_id ?? null, status: checkpoint.status === "completed" ? "completed" : "resumable", last_completed_turn: checkpoint.last_completed_turn ?? 0, last_tool: checkpoint.last_tool ?? null, updated_at: checkpoint.updated_at } });
    } catch (error) { runtimeLogger.emit({ event_name: "agent.checkpoint_publish_failed", level: "error", status: "failed", message: "Could not publish direct code checkpoint.", task_id: checkpoint.task_id, source: "control-api", error_code: error.code ?? "CHECKPOINT_PUBLISH_FAILED", payload: { error: error.message } }); }
  },
  conversationStateStore, protocolStorage, testService, gitService, reportService, ticketWorkspaceService, shadowComparison: ticketPipelineShadow, onEvalCase, enableReadCode: true, autoStartWorkers: false,
  preparation: {
    createTaskSession: async ({ task_id, ticket } = {}) => {
      const existing = taskStore.get(task_id);
      if (!existing) taskStore.create({ id: task_id, type: "custom", title: ticket?.title ?? task_id, description: ticket?.objective ?? "", acceptance_criteria: ticket?.acceptance_criteria ?? [], status: "pending", created_at: new Date().toISOString() });
      return { session_id: `SESSION-${task_id}` };
    },
    createBranch: async ({ task_id } = {}) => ticketWorkspaceService.ensure(task_id),
    resolveCodeIndex: async () => `IDX-${indexDb.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`,
    persist: async () => ({ persisted: true })
  }
});
createTerminalBridge({
  eventBus: supervisorRuntime.eventBus, ticketStatusStore, roadmaps, projectId,
  taskSummaries, projectMemory,
  logger: runtimeLogger.emit
});
await supervisorRuntime.recover();
await supervisorRuntime.startWorkers();
const dispatchTask = createApprovedTicketDispatch({ projectId, sprintRegistry, ticketStatusStore, integration: supervisorRuntime.integration });
const directCodeRequest = createDirectCodeRequest({ fileService, integration: supervisorRuntime.integration, checkpoints: supervisorRuntime.agentCheckpoints, projectId, projectLogger: logEvent });
const ticketHumanReviewService = createTicketHumanReviewService({ projectId, roadmaps, ticketStatusStore, checkpoints: supervisorRuntime.agentCheckpoints, agentOccupancy, ticketWorkspaceService, publisher: eventPublisher, projectLogger: runtimeLogger.emit });

// Sprint execution runs one level at a time, gating each ticket on its
// predecessors' terminal ticket status via the execution event bus.
const sprintDagRunner = createSprintDagRunner({ ticketStatusStore, sprintRegistry, eventBus: supervisorRuntime.eventBus, dispatchTask: ({ ticket, sprintBasis, dependencyExpectations }) => dispatchTicket({ projectId: ticket.project_id, ticketId: ticket.id, expectedSprintVersion: sprintBasis?.version, dependencyExpectations }), logEvent });
const sprintLeaderIntake = createSprintLeaderIntakeService({ fileService, roadmaps, logger: logEvent });

const dispatchTicket = createTicketRunDispatch({ disposition: ticketPipelineDisposition, intake: sprintLeaderIntake, sprintRegistry, ticketStatusStore, checkpoints: supervisorRuntime.agentCheckpoints, queueStore: supervisorRuntime.queueStore, protocolStorage, conversationStateStore, dispatchTask });
const reviewTicket = async ({ projectId: requestedProjectId, ticketId, body = {} } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === requestedProjectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  return supervisorRuntime.integration.reviewOnly({ ticket, task_id: ticketId, project_id: requestedProjectId, request_id: body.request_id, correlation_id: body.correlation_id, commit: body.commit, base_commit: body.base_commit, changed_paths: body.changed_paths, evidence: body.evidence, coder_agent_id: body.coder_agent_id });
};
// Dedicated Codex Forge tool-lab entry point. Runs the fixed six-tool MCP
// sequence (search_code -> read_file -> write_diff -> run_test -> commit_changes
// -> report_done) through the same production Codex SDK + MCP pipeline as a
// real ticket, using a synthetic ticket and payload.tool_test to select lab
// mode inside runCodexTask. This is separate from POST /tickets/:id:run so a
// lab run never clears or reuses a real ticket's protocol/conversation state.
const runToolLab = async ({ projectId: requestedProjectId, targetPath, allowedPrefixes, approvalPolicy, taskId } = {}) => {
  const labTaskId = taskId ?? `CODEX-TOOL-LAB-${Date.now()}`;
  const ticket = { id: labTaskId, project_id: requestedProjectId ?? projectId, title: "Codex Forge Tool Lab", objective: "Run the fixed six-tool Forge MCP integration test.", acceptance_criteria: ["Complete search_code -> read_file -> write_diff -> run_test -> commit_changes -> report_done."], required_role: "coder" };
  const result = await supervisorRuntime.integration.submitTicket({
    ticket, task_id: labTaskId, project_id: ticket.project_id, request_id: `REQ-${labTaskId}`, correlation_id: `CORR-TOOL-LAB-${labTaskId}`, required_role: "coder",
    payload: { tool_test: { target_path: targetPath ?? "backend/tool-lab-target.txt", allowed_prefixes: allowedPrefixes ?? ["backend/"], ...(approvalPolicy ? { approval_policy: approvalPolicy } : {}) }, ticket, task: ticket }
  });
  return { task_id: labTaskId, supervisor_id: result.supervisor_id, status: result.status === "already_running" ? "already_running" : "accepted", pipeline: "supervisor-tool-lab" };
};
const dispatchSprint = createSprintRunDispatch({ projectId, sprintRegistry, sprintDagRunner, logEvent });

const publishUnifiedStreamEvent = createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent });

const api = createControlApiHttp({ services: {
  bus, communications, conversations, eventStore, indexDb: platformIndexDb, subscriptions, knowledge, roadmaps, sprintPlans, provenance, gitService, planFileService, sprintPlanLeader,
  planStore, markdownPlanStore, sprintRegistry, planOwnerAuth, database, agentRoleResolver, testService,
  relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, dispatchTicket, runToolLab, directCodeRequest, internalBus,
  proseTicketService, buildBuilderContext, protocolStorage, conversationStateStore, fileService, codeCache, codeSearch, agentGateway, agentConfiguration, sdkGateways: Object.fromEntries([claudeSdkGateway, { ...claudeSdkGateway, provider: "anthropic" }, codexSdkGateway, { ...ollamaSdkGateway }, openaiSdkGateway, ...["xai", "alibaba", "zhipu", "deepseek"].map((provider) => ({ ...openaiSdkGateway, provider }))].map((gateway) => [gateway.provider, gateway])), projectRoot: config.cwd, publishUnifiedStreamEvent,
  ticketCrudService: createTicketCrudService({ roadmaps, proseTicketService, ticketFileStore, publisher: eventPublisher, agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId }), agentRoleResolver, sprintLeader: ticketSprintLeader }),
  dispatchTask, dispatchSprint, reviewTicket, ticketHumanReviewService, logEvent, projectId,
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, ticketFileStore, ticketStatusStore, sprintRegistry, relevantTreeSelector, logReader: ({ ticket_id }) => readLogEvents({ project_id: projectId, ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  listResumableCheckpoints: async () => {
    const coderPending = await supervisorRuntime.agentCheckpoints.listPending();
    const reviewPending = await supervisorRuntime.agentCheckpoints.listReviewPending();
    const reviewReady = [];
    for (const review of reviewPending) {
      const coder = await supervisorRuntime.agentCheckpoints.load(review.task_id);
      if (coder?.status === "completed" && reviewPhaseResume(coder, review)) reviewReady.push({ ...coder, phase: "review" });
    }
    return [...coderPending, ...reviewReady];
  },
  humanDecisionService: createHumanDecisionService({ decisions, bus })
} });
startControlApi({ api, port, host, indexDb, controlDb, processLock, codeCache, ticketWorkspaceService, workers: [supervisorRuntime.senderWorker, supervisorRuntime.collectorWorkerLoop, supervisorRuntime.verificationWorkerLoop].filter(Boolean) });
