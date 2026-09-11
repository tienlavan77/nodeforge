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
import { createClaudeSdkGateway } from "../src/modules/agent/claude-sdk-gateway.js";
import { createOpenAiSdkProviderFactory } from "../src/modules/agent/openai-sdk-provider.js";
import { createOpenAiSdkGateway } from "../src/modules/agent/openai-sdk-gateway.js";
import { createCodexSdkGateway } from "../src/modules/agent/codex-sdk-gateway.js";
import { createSupervisorRoundController } from "../src/modules/supervisor/round-controller.js";
import { createCodeIndexSummaryBuilder } from "../src/modules/index/code-index-summary-builder.js";
import { createStage1ReportService } from "../src/modules/workflows/stage1-report-service.js";

const config = readControlApiConfig();
const { port, host, dataDir } = config;
let testService;
const storage = await createControlApiStorage({
  config,
  onWrite: createOnWriteVerifier({ getTestService: () => testService })
});
const { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb } = storage;
const database = controlDb;
const { profiles, agentConfiguration, secrets, agentGateway, agentSettings, agentRoleResolver } = createControlApiAgent({ database, fileService, config });
const claudeSdkGateway = createClaudeSdkGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference) });
const openaiSdkProviderFactory = createOpenAiSdkProviderFactory({ credentialResolver: (reference) => secrets.get(reference) });
const openaiSdkGateway = createOpenAiSdkGateway({ providerFactory: openaiSdkProviderFactory });
const codexSdkGateway = createCodexSdkGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference) });
const platform = createControlApiPlatform({ config, database, indexDb, fileService, agentGateway, logEvent });
const gitService = createGitService({ projectRoot: config.cwd });
const reportService = createStage1ReportService({ protocolStorage, fileService, gitService });
const { projectId, codeSearch, fileGraph, relevantTreeSelector, communications, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, verificationOrchestrator, contextEngine, runtimeService, sprintOrchestration, ticketCommandParser, proseTicketService, sprintPlanUpload } = platform;
testService = platform.testService;
const unifiedStreamOrder = createUnifiedStreamOrderer();
const buildBuilderContext = createBuilderContext({ roadmaps, indexDb, contextEngine });
const codeIndexSummaryBuilder = createCodeIndexSummaryBuilder({ fileService, indexDb });
const supervisorRuntime = createProductionSupervisorRuntime({ projectRoot: config.cwd, fileService, root: ".forge/runtime", eventStore, agentGateway, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, agentRoleResolver, codeSearch, relevantTreeSelector, logger: console, projectLogger: (entry) => { try { logEvent({ timestamp: new Date().toISOString(), ...entry }); } catch (error) { console.error("Project log failed", error); } console.log(`[worker-log] ${entry?.event_name ?? "event"}`, JSON.stringify({ task_id: entry?.task_id, request_id: entry?.payload?.request_id, tool: entry?.payload?.tool, target_exists: entry?.payload?.target_exists, before_checksum_present: entry?.payload?.before_checksum_present, before_checksum_format_valid: entry?.payload?.before_checksum_format_valid, duration_ms: entry?.payload?.duration_ms, status: entry?.status, error: entry?.error_code })); if (entry?.event_name === "materializer.request_completed") console.log(`[materialization] ${entry?.status ?? "completed"}`, JSON.stringify({ valid: entry?.payload?.valid_patches ?? [], invalid: entry?.payload?.invalid_patches ?? [], invalid_count: Array.isArray(entry?.payload?.invalid_patches) ? entry.payload.invalid_patches.length : 0 })); },
  conversationStateStore, protocolStorage, codeSearch, testService, gitService, reportService, enableReadCode: true, autoStartWorkers: false,
  roundControllerFactory: (runtime, stores) => createSupervisorRoundController({
    conversationStateStore: stores.conversationStateStore, protocolStorage: stores.protocolStorage, fileService: stores.fileService, toolRegistry: stores.toolRegistry, conversationId: `CONV-BUILDER-PROJECT-NODEFORGE-${runtime.taskId}`,
    projectLogger: (entry) => { try { logEvent({ timestamp: new Date().toISOString(), ...entry }); } catch (error) { console.error("Project log failed", error); } console.log(`[round] ${entry?.event_name ?? "event"}`, JSON.stringify({ task_id: entry?.task_id, request_id: entry?.payload?.request_id, round: entry?.payload?.round, type: entry?.payload?.type, status: entry?.status, error_code: entry?.payload?.error_code ?? entry?.error_code })); },
    contextProvider: async ({ response } = {}) => buildFileContext(response, { summary: true }),
    fullContextProvider: async ({ response } = {}) => buildFileContext(response, { summary: false, plan: response?.plan ?? response?.payload?.plan }),
    persistPlan: async () => ({ persisted: true }),
    executionContextProvider: stores.executionContextProvider
  }),
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

const dispatchTask = async ({ ticket, message, required_role } = {}) => supervisorRuntime.integration.submitTicket({ ticket, task_id: ticket.id, project_id: ticket.project_id, request_id: message?.id, correlation_id: message?.correlation_id, required_role: required_role ?? ticket.required_role ?? "coder", payload: { text: `Ticket ${ticket.id}: ${ticket.title ?? ""}\nObjective: ${ticket.objective ?? ""}\nAcceptance: ${(ticket.acceptance_criteria ?? []).join("; ")}`, task: { id: ticket.id, title: ticket.title, objective: ticket.objective, dependencies: ticket.dependencies ?? [], acceptance_criteria: ticket.acceptance_criteria ?? [] }, ticket } });

const runningSprints = new Set();

const dispatchTicket = async ({ projectId, ticketId, conversationId } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  const runtimeStatus = ticketStatusStore.get(ticketId);
  const ownerState = supervisorRuntime.supervisorManager.getByTask(ticketId)?.getState?.();
  const terminalOwner = ["FAILED", "COMPLETED", "NEEDS_HUMAN_REVIEW"].includes(ownerState);
  if (["planned", "failed", "needs_human_review"].includes(ticket.status) || ["failed", "needs_human_review"].includes(runtimeStatus?.status) || terminalOwner) {
    await protocolStorage.clearTask(ticketId);
    await conversationStateStore.clear(`CONV-BUILDER-PROJECT-NODEFORGE-${ticketId}`);
  }
  const correlationId = `CORR-UI-RUN-${ticketId}-${Date.now()}`;
  const result = await dispatchTask({ ticket, message: { id: `REQ-${ticketId}-${Date.now()}`, correlation_id: correlationId } });
  return { ticket_id: ticketId, supervisor_id: result.supervisor_id, status: result.status === "already_running" ? "already_running" : "accepted", pipeline: "supervisor" };
};
const dispatchSprint = async ({ projectId: requestedProjectId, sprintId } = {}) => {
  const sprint = sprintPlans.getSprintById(sprintId);
  if (!sprint || sprint.project_id !== requestedProjectId) { const error = new Error(`Sprint not found: ${sprintId}`); error.statusCode = 404; throw error; }
  if (runningSprints.has(sprintId)) { const error = new Error(`Sprint is already running: ${sprintId}`); error.statusCode = 409; throw error; }
  const tickets = sprint.tickets ?? [];
  if (!tickets.length) { const error = new Error(`Sprint has no tickets: ${sprintId}`); error.statusCode = 400; throw error; }
  runningSprints.add(sprintId);
  try {
    const results = await Promise.all(tickets.map((ticket) => dispatchTask({ ticket: { ...ticket, project_id: ticket.project_id ?? requestedProjectId }, message: { id: `REQ-${ticket.id}-${Date.now()}`, correlation_id: `CORR-UI-RUN-${sprintId}-${ticket.id}-${Date.now()}` } })));
    return { sprint_id: sprintId, status: results.every((result) => result.status === "already_running") ? "already_running" : "accepted", pipeline: "supervisor", tickets: results };
  } finally { runningSprints.delete(sprintId); }
};

const publishUnifiedStreamEvent = createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent });

const api = createControlApiHttp({ services: {
  runtimeService, bus, communications, eventStore, subscriptions, knowledge, roadmaps, sprintPlans, provenance,
  relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, dispatchTicket, internalBus,
  ticketCommandParser, proseTicketService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent,
  dispatchTask, dispatchSprint, logEvent, projectId,
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, relevantTreeSelector, logReader: ({ ticket_id }) => readLogEvents({ project_id: projectId, ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  humanDecisionService: createHumanDecisionService({ decisions, bus })
} });

startControlApi({ api, port, host, indexDb, controlDb, processLock, workers: [supervisorRuntime.senderWorker, supervisorRuntime.materializerWorkerLoop, supervisorRuntime.verificationWorkerLoop].filter(Boolean) });
