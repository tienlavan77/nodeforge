import process from "node:process";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";

process.chdir(resolve(new URL("../..", import.meta.url).pathname));
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
import { createOpenAiSdkProviderFactory } from "../src/modules/agent/openai-sdk-provider.js";
import { createOpenAiSdkGateway } from "../src/modules/agent/openai-sdk-gateway.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { createSprintDagRunner, topologicalTicketLevels } from "../src/modules/supervisor/sprint-dag.js";
import { createCodeIndexSummaryBuilder } from "../src/modules/index/code-index-summary-builder.js";
import { createCompletionReportService } from "../src/modules/supervisor/completion-report-service.js";
import { createEvalCaseRecorder } from "../src/modules/eval/eval-case-store.js";
import { createTicketCrudService } from "../src/application/ticket-crud-service.js";
import { createAgentExecutionCheckpointStore } from "../src/modules/agent/agent-execution-checkpoint.js";

const config = readControlApiConfig();
const { port, host, dataDir } = config;
let testService;
const storage = await createControlApiStorage({
  config,
  onWrite: createOnWriteVerifier({ getTestService: () => testService })
});
const { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb } = storage;
const database = controlDb;
const { profiles, agentConfiguration, secrets, agentGateway, claudeSdkGateway, codexSdkGateway, ollamaSdkGateway, agentSettings, agentRoleResolver } = createControlApiAgent({ database, fileService, config });
const openaiSdkProviderFactory = createOpenAiSdkProviderFactory({ credentialResolver: (reference) => secrets.get(reference) });
const openaiSdkGateway = createOpenAiSdkGateway({ providerFactory: openaiSdkProviderFactory });
const platform = createControlApiPlatform({ config, database, indexDb, fileService, agentGateway, claudeSdkGateway, codexSdkGateway, agentRoleResolver, logEvent });
const gitService = createGitService({ projectRoot: config.cwd });
const reportService = createCompletionReportService({ protocolStorage, fileService, gitService });
const onEvalCase = createEvalCaseRecorder({ root: config.cwd });
const { projectId, indexDb: platformIndexDb, codeSearch, fileGraph, relevantTreeSelector, freshnessChecker, ticketCandidateResolver, ticketSprintLeader, memoryRetriever, communications, conversations, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, verificationOrchestrator, contextEngine, sprintOrchestration, ticketCommandParser, proseTicketService, ticketFileStore, sprintPlanUpload, taskSummaries, projectMemory } = platform;
testService = platform.testService;
const unifiedStreamOrder = createUnifiedStreamOrderer();
const runtimeLogger = createRuntimeLogger({ logEvent });
const buildBuilderContext = createBuilderContext({ roadmaps, indexDb, contextEngine });
const codeIndexSummaryBuilder = createCodeIndexSummaryBuilder({ fileService, indexDb });
const supervisorRuntime = createProductionSupervisorRuntime({ projectRoot: config.cwd, fileService, root: ".forge/runtime", eventStore, agentGateway, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, agentRoleResolver, codeSearch, relevantTreeSelector, freshnessChecker, logger: runtimeLogger, projectLogger: runtimeLogger.emit,
  conversationStateStore, protocolStorage, codeSearch, testService, gitService, reportService, onEvalCase, enableReadCode: true, autoStartWorkers: false,
  preparation: {
    createTaskSession: async ({ task_id, project_id, ticket } = {}) => {
      const existing = taskStore.get(task_id);
      if (!existing) taskStore.create({ id: task_id, type: "custom", title: ticket?.title ?? task_id, description: ticket?.objective ?? "", acceptance_criteria: ticket?.acceptance_criteria ?? [], status: "pending", created_at: new Date().toISOString() });
      return { session_id: `SESSION-${task_id}` };
    },
    createBranch: async ({ task_id, branch } = {}) => {
      if (await gitService.branchExists(branch)) return { branch, reused: true };
      return gitService.createBranch(branch);
    },
    resolveCodeIndex: async () => `IDX-${indexDb.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`,
    persist: async () => ({ persisted: true })
  }
});
const terminalBridge = createTerminalBridge({
  eventBus: supervisorRuntime.eventBus, ticketStatusStore, roadmaps, projectId,
  taskSummaries, projectMemory,
  logger: runtimeLogger.emit
});
await supervisorRuntime.recover();
await supervisorRuntime.startWorkers();
async function buildFileContext(response = {}, options = {}) {
  const plan = options.plan ?? response.plan ?? response.payload?.plan ?? [];
  const requested = response.files_requested ?? response.payload?.files_requested ?? plan.map((item) => item.path) ?? [];
  const newPaths = new Set(plan.filter((item) => item?.action === "NEW").map((item) => item.path));
  const readOnlyPaths = new Set(plan.filter((item) => item?.action === "READ_ONLY").map((item) => item.path));
  const existing = requested.filter((path) => !newPaths.has(path) && !readOnlyPaths.has(path));
  const files = await codeIndexSummaryBuilder.build(existing, { ...options, summary: options.summary !== false });
  return [
    ...files,
    ...[...newPaths].map((path) => ({ path, exists: false, before_checksum: null, language: path.split(".").pop() ?? null, size_bytes: 0, content: null })),
    ...[...readOnlyPaths].map((path) => ({ path, exists: false, before_checksum: null, language: path.split(".").pop() ?? null, size_bytes: 0, content: null }))
  ];
}

function isSourceCandidate(entry = {}) {
  const path = String(entry.path ?? "");
  return !path.split("/").some((segment) => segment.startsWith(".")) && /\.(?:js|jsx|ts|tsx|css|scss)$/.test(path);
}

function isFrontendTicket(ticket = {}) { return /\bfrontend\b|\breact\b|\bnext(?:\.js)?\b|\bjsx\b/i.test([ticket.title, ticket.objective, ...(ticket.acceptance_criteria ?? [])].join(" ")); }

const dispatchTask = async ({ ticket, message, required_role, resume_from } = {}) => supervisorRuntime.integration.submitTicket({ ticket, task_id: ticket.id, project_id: ticket.project_id, request_id: message?.id, correlation_id: message?.correlation_id, required_role: required_role ?? ticket.required_role ?? "coder", payload: { text: `Ticket ${ticket.id}: ${ticket.title ?? ""}\nObjective: ${ticket.objective ?? ""}\nAcceptance: ${(ticket.acceptance_criteria ?? []).join("; ")}`, task: { id: ticket.id, title: ticket.title, objective: ticket.objective, dependencies: ticket.dependencies ?? [], acceptance_criteria: ticket.acceptance_criteria ?? [] }, ticket, ...(resume_from ? { resume_from } : {}) } });

// Sprint execution runs one level at a time, gating each ticket on its
// predecessors' terminal ticket status via the execution event bus.
const sprintDagRunner = createSprintDagRunner({ ticketStatusStore, eventBus: supervisorRuntime.eventBus, dispatchTask, logEvent });

const runningSprints = new Set();

const dispatchTicket = async ({ projectId, ticketId, conversationId, fresh = false } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  // Resume by default: an unfinished checkpoint means a previous run crashed
  // mid-execution, so keep protocol/conversation state and let the agent
  // continue from the last completed turn. `fresh: true` forces the old
  // behavior of clearing everything and starting over.
  // A checkpoint is retained after report_done for auditing, so only resume
  // from it while it is still unfinished (status !== "completed").
  const checkpoint = fresh ? null : await supervisorRuntime.agentCheckpoints.load(ticketId).catch(() => null);
  const resume = checkpoint && checkpoint.status !== "completed" ? checkpoint : null;

  if (!resume) {
    // An explicit fresh RUN clears prior protocol records
    // (request/response/report/final_report), conversation state, and any
    // checkpoint (including completed audit records) first, so a stale
    // final_report from an earlier attempt cannot cause STORAGE_CONFLICT or
    // get silently reused regardless of the ticket's current status.
    await supervisorRuntime.agentCheckpoints.clear(ticketId).catch(() => {});
    await protocolStorage.clearTask(ticketId);
    await conversationStateStore.clear(`CONV-BUILDER-PROJECT-NODEFORGE-${ticketId}`);
  }
  const correlationId = `CORR-UI-RUN-${ticketId}-${Date.now()}`;
  const result = await dispatchTask({ ticket, message: { id: `REQ-${ticketId}-${Date.now()}`, correlation_id: correlationId }, ...(resume ? { resume_from: resume } : {}) });
  return { ticket_id: ticketId, supervisor_id: result.supervisor_id, status: result.status === "already_running" ? "already_running" : "accepted", pipeline: "supervisor", ...(resume ? { resumed: true, resumed_from_turn: resume.last_completed_turn ?? 0 } : {}) };
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
const dispatchSprint = async ({ projectId: requestedProjectId, sprintId } = {}) => {
  const sprint = sprintPlans.getSprintById(sprintId);
  if (!sprint || sprint.project_id !== requestedProjectId) { const error = new Error(`Sprint not found: ${sprintId}`); error.statusCode = 404; throw error; }
  if (runningSprints.has(sprintId)) { const error = new Error(`Sprint is already running: ${sprintId}`); error.statusCode = 409; throw error; }
  const tickets = sprint.tickets ?? [];
  if (!tickets.length) { const error = new Error(`Sprint has no tickets: ${sprintId}`); error.statusCode = 400; throw error; }
  const levels = topologicalTicketLevels(tickets);
  runningSprints.add(sprintId);
  const execution = sprintDagRunner.runSprintLevels({ projectId: requestedProjectId, sprintId, levels });
  execution.catch((error) => logEvent({ event_name: "sprint.execution_failed", level: "error", status: "failed", message: "Sprint DAG execution failed.", project_id: requestedProjectId, source: "sprint-execution", payload: { sprint_id: sprintId, error_code: error.code ?? "SPRINT_EXECUTION_FAILED", error: error.message } })).finally(() => runningSprints.delete(sprintId));
  return { sprint_id: sprintId, status: "accepted", pipeline: "supervisor", execution: "sprint-execution", levels: levels.map((level) => level.map((ticket) => ticket.id)) };
};


const publishUnifiedStreamEvent = createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent });

const api = createControlApiHttp({ services: {
  bus, communications, conversations, eventStore, indexDb: platformIndexDb, subscriptions, knowledge, roadmaps, sprintPlans, provenance,
  relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, dispatchTicket, runToolLab, internalBus,
  ticketCommandParser, proseTicketService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent,
  ticketCrudService: createTicketCrudService({ roadmaps, proseTicketService, ticketFileStore, publisher: eventPublisher, agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId }), agentRoleResolver, candidateResolver: ticketCandidateResolver, sprintLeader: ticketSprintLeader }),
  dispatchTask, dispatchSprint, logEvent, projectId,
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, ticketFileStore, relevantTreeSelector, logReader: ({ ticket_id }) => readLogEvents({ project_id: projectId, ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  listResumableCheckpoints: () => supervisorRuntime.agentCheckpoints.listPending(),
  humanDecisionService: createHumanDecisionService({ decisions, bus })
} });

startControlApi({ api, port, host, indexDb, controlDb, processLock, workers: [supervisorRuntime.senderWorker, supervisorRuntime.collectorWorkerLoop, supervisorRuntime.verificationWorkerLoop].filter(Boolean) });
