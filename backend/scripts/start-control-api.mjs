import process from "node:process";
import { createHash } from "node:crypto";
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
import { createSupervisorRoundController } from "../src/modules/supervisor/round-controller.js";

const config = readControlApiConfig();
const { port, host, dataDir } = config;
let testService;
const storage = await createControlApiStorage({
  config,
  onWrite: createOnWriteVerifier({ getTestService: () => testService })
});
const { fileService, protocolStorage, conversationStateStore, processLock, controlDb, indexDb } = storage;
const database = controlDb;
const { profiles, agentConfiguration, secrets, agentGateway, agentSettings } = createControlApiAgent({ database, fileService, config });
const platform = createControlApiPlatform({ config, database, indexDb, fileService, agentGateway, logEvent });
const gitService = createGitService({ projectRoot: config.cwd });
const { projectId, codeSearch, fileGraph, relevantTreeSelector, communications, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, verificationOrchestrator, contextEngine, runtimeService, sprintOrchestration, ticketCommandParser, proseTicketService, sprintPlanUpload } = platform;
testService = platform.testService;
const unifiedStreamOrder = createUnifiedStreamOrderer();
const buildBuilderContext = createBuilderContext({ roadmaps, indexDb, contextEngine });
const supervisorRuntime = createProductionSupervisorRuntime({ fileService, root: ".forge/runtime", eventStore, agentGateway, logger: console,
  conversationStateStore, protocolStorage,
  roundControllerFactory: (runtime, stores) => createSupervisorRoundController({
    conversationStateStore: stores.conversationStateStore, protocolStorage: stores.protocolStorage, conversationId: `CONV-BUILDER-PROJECT-NODEFORGE-${runtime.taskId}`,
    contextProvider: async ({ response } = {}) => buildFileContext(response, { summary: false }),
    fullContextProvider: async ({ response } = {}) => buildFileContext(response, { summary: false }),
    persistPlan: async () => ({ persisted: true })
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
async function buildFileContext(response = {}, { summary = false } = {}) {
  const requested = response.files_requested ?? response.payload?.files_requested ?? response.plan?.map((item) => item.path) ?? [];
  const paths = [...new Set(Array.isArray(requested) ? requested.filter((path) => typeof path === "string" && path) : [])];
  return Promise.all(paths.map(async (path) => {
    const content = await fileService.readFile({ path });
    const indexed = indexDb.all("SELECT file_id, path, language, size_bytes, sha256 FROM files WHERE path = ? LIMIT 1", [path])[0] ?? {};
    const symbols = indexed.file_id ? indexDb.all("SELECT name, kind FROM symbols WHERE file_id = ? ORDER BY start_line, name", [indexed.file_id]) : [];
    const description = symbols.length ? `symbols: ${symbols.map((symbol) => `${symbol.kind ?? "symbol"} ${symbol.name}`).join(", ")}` : "no indexed symbols";
    return {
      path,
      exists: true,
      before_checksum: indexed.sha256 ? `sha256:${indexed.sha256.replace(/^sha256:/, "")}` : `sha256:${createHash("sha256").update(content).digest("hex")}`,
      language: indexed.language ?? "text",
      size_bytes: Number(indexed.size_bytes ?? Buffer.byteLength(content)),
      content: summary ? `${path} — ${description}` : content
    };
  }));
}

function isSourceCandidate(entry = {}) {
  const path = String(entry.path ?? "");
  return !path.split("/").some((segment) => segment.startsWith(".")) && /\.(?:js|jsx|ts|tsx|css|scss)$/.test(path);
}

function isFrontendTicket(ticket = {}) { return /\bfrontend\b|\breact\b|\bnext(?:\.js)?\b|\bjsx\b/i.test([ticket.title, ticket.objective, ...(ticket.acceptance_criteria ?? [])].join(" ")); }

const dispatchTask = async ({ ticket, message } = {}) => supervisorRuntime.integration.startTask({ ticket, restart: ["failed", "needs_human_review"].includes(ticket.status), task_id: ticket.id, project_id: ticket.project_id, request_id: message?.id, correlation_id: message?.correlation_id, relevantTree: relevantTreeSelector.select({
    title: ticket.title, objective: ticket.objective, acceptance_criteria: ticket.acceptance_criteria,
    limit: 30,
    ...(isFrontendTicket(ticket) ? { scope: "frontend", allowed_prefixes: ["frontend/"] } : {})
  }).tree.filter(isSourceCandidate).slice(0, 3), payload: { text: `Ticket ${ticket.id}: ${ticket.title ?? ""}\nObjective: ${ticket.objective ?? ""}\nAcceptance: ${(ticket.acceptance_criteria ?? []).join("; ")}`, task: { id: ticket.id, title: ticket.title, objective: ticket.objective, dependencies: ticket.dependencies ?? [], acceptance_criteria: ticket.acceptance_criteria ?? [] }, ticket } });

const ticketRunner = async ({ projectId, ticketId, conversationId } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  const runtimeStatus = ticketStatusStore.get(ticketId);
  if (["planned", "failed", "needs_human_review"].includes(ticket.status) || ["failed", "needs_human_review"].includes(runtimeStatus?.status)) {
    await protocolStorage.clearTask(ticketId);
    await conversationStateStore.clear(`CONV-BUILDER-PROJECT-NODEFORGE-${ticketId}`);
  }
  const correlationId = `CORR-UI-RUN-${ticketId}-${Date.now()}`;
  const result = await dispatchTask({ ticket, message: { id: `REQ-${ticketId}-${Date.now()}`, correlation_id: correlationId } });
  return { ticket_id: ticketId, supervisor_id: result.supervisor_id, status: "accepted", pipeline: "supervisor" };
};
const publishUnifiedStreamEvent = createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent });

const api = createControlApiHttp({ services: {
  runtimeService, bus, communications, eventStore, subscriptions, knowledge, roadmaps, sprintPlans, provenance,
  relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, ticketRunner, internalBus,
  ticketCommandParser, proseTicketService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent,
  dispatchTask, logEvent, projectId,
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, relevantTreeSelector, logReader: ({ ticket_id }) => readLogEvents({ project_id: projectId, ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  humanDecisionService: createHumanDecisionService({ decisions, bus })
} });

startControlApi({ api, port, host, indexDb, controlDb, processLock, workers: [supervisorRuntime.senderWorker, supervisorRuntime.repairWorker, supervisorRuntime.materializerWorkerLoop, supervisorRuntime.verificationWorkerLoop] });
