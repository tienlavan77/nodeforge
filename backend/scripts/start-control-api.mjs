import process from "node:process";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";

process.chdir(resolve(new URL("../..", import.meta.url).pathname));
loadNodeforgeEnv();

import { createRuntimeService } from "../src/application/runtime-service.js";
import { createArchitectureWorkspaceService } from "../src/application/architecture-workspace-service.js";
import { createProjectDashboardService } from "../src/application/project-dashboard-service.js";
import { createConversationAuditHistoryService } from "../src/application/conversation-audit-history-service.js";
import { createHumanDecisionService } from "../src/application/human-decision-service.js";
import { createAgentSettingsService } from "../src/application/agent-settings-service.js";
import { createNodeAgentConfiguration } from "../src/modules/agent/node-agent-configuration.js";
import { createAgentGateway } from "../src/modules/agent/agent-gateway.js";
import { createAgentProfileStore } from "../src/modules/agent/agent-profile-store.js";
import { createPersistentSecretBackend } from "../src/modules/agent/persistent-secret-backend.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";
import { createDatabaseService } from "../src/infrastructure/sqlite/database-service.js";
import { createAgentSessionStore } from "../src/modules/agent/session-store.js";
import { createPersistentEventStore } from "../src/modules/events/persistent-event-store.js";
import { createMemoryRetriever } from "../src/modules/history/memory-retriever.js";
import { createAgentCommunicationBus } from "../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../src/modules/governance/architecture-knowledge-model.js";
import { createRoadmapStore } from "../src/modules/governance/roadmap-store.js";
import { createSprintPlanProjection } from "../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../src/modules/governance/ticket-provenance-tracker.js";
import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";
import { createContextEngine } from "../src/modules/context/context-engine.js";
import { createFilesystemAwareContextService } from "../src/modules/agent/filesystem-aware-context-service.js";
import { createAgentContextService } from "../src/modules/agent/context-service.js";
import { createContextBudgetManager } from "../src/modules/agent/context-budget-manager.js";
import { createAgentRuntime } from "../src/modules/agent/agent-runtime.js";
import { createPlanningEngine } from "../src/modules/agent/planning-engine.js";
import { createTaskStore } from "../src/modules/projects/task-store.js";
import { createTicketStatusStore } from "../src/modules/projects/ticket-status-store.js";
import { createSubscriptionRegistry } from "../src/modules/events/subscription-registry.js";
import { createEventPublisher } from "../src/modules/events/event-publisher.js";
import { createHistoryStore } from "../src/modules/history/history-store.js";
import { createTaskSummaryStore } from "../src/modules/history/task-summary-store.js";
import { createProjectMemoryStore } from "../src/modules/history/project-memory-store.js";
import { createSprintPlanUploadService } from "../src/application/sprint-plan-upload-service.js";
import { createSprintOrchestrationService } from "../src/application/sprint-orchestration-service.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createTestService } from "../src/application/test-service.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createProtocolStorage } from "../src/infrastructure/storage/protocol-storage.js";
import { createGitService } from "../src/infrastructure/git/git-service.js";
import { createUnifiedStreamOrderer } from "../src/modules/events/unified-stream-order.js";
import { createTicketCommandParser } from "../src/application/ticket-command-parser.js";
import { createProseTicketService } from "../src/application/prose-ticket-service.js";
import { createStage1TaskRequestBuilder } from "../src/modules/workflows/stage1-task-request-builder.js";
import { createStage1TicketRunner } from "../src/modules/workflows/stage1-ticket-runner.js";
import { createStage1VerificationGate } from "../src/modules/workflows/stage1-verification-gate.js";
import { createStage1ReportService } from "../src/modules/workflows/stage1-report-service.js";
import { stage1AgentTools } from "../src/modules/workflows/stage1-agent-tools.js";
import { createFileRepository } from "../src/modules/index/file-repository.js";
import { createCodeSearch } from "../src/modules/index/code-search.js";
import { createFileGraph } from "../src/modules/index/file-graph.js";
import { createRelevantTreeSelector } from "../src/modules/index/relevant-tree.js";
import { createProtocolStepLogger } from "../src/modules/protocol/protocol-step-logger.js";
import { configureProjectLogFileService, logEvent, readLogEvents } from "../src/core/project-log-service.js";

const port = Number(process.env.NODE_CONTROL_PORT ?? 3100);
const host = process.env.NODE_CONTROL_HOST ?? "127.0.0.1";
const runtimeRoot = join(process.cwd(), ".forge", "runtime");
const dataDir = process.env.NODE_CONTROL_DATA_DIR ?? join(runtimeRoot, "nf");
let testService;
const fileService = createFileService({
  projectRoot: process.cwd(),
  databaseService: undefined,
  onWrite: async ({ path }) => {
    // Source tests are verified after writes; non-test files continue through the watcher pipeline.
    if (!testService || !isTestSourcePath(path)) return;
    const result = await testService.runTests({ commitId: `FILE-${path}-${Date.now()}`, levels: ["unit_test"], taskId: path });
    if (result.status !== "passed" || result.ready_for_review !== true) {
      const error = new Error(`Verification failed for ${path}: ${result.status}`);
      error.verificationResult = result;
      throw error;
    }
    return result;
  }
});
const protocolStorage = createProtocolStorage({ fileService, root: process.env.FORGE_PROTOCOL_STORAGE_ROOT ?? ".forge/runtime/protocol-storage" });
configureProjectLogFileService(fileService);
// Keep UI-control persistence isolated from the repository index database.
const processLock = acquireProcessLock(dataDir, "control", { fileService });
// Control DB (.forge/runtime/nf) — chats, agents, sessions, events
const controlDb = await createDatabaseService({ dataDir, runtimeDir: "." });
// Index DB (.forge/runtime/wc/index.db) — watcher/indexer/context sharing
// Project index uses the same queued DatabaseService as the watcher. Reads stay
// parallel under WAL, while all index mutations are serialized through `write`.
const indexDb = await createDatabaseService({ dataDir: process.cwd(), runtimeDir: join(".forge", "runtime", "wc") });
const codeSearch = createCodeSearch({ database: indexDb });
const fileGraph = createFileGraph({ database: indexDb });
const relevantTreeSelector = createRelevantTreeSelector({ search: codeSearch, fileGraph, maxFiles: 30, defaultDepth: 1 });
const database = controlDb;
const communications = createAgentCommunicationStore({ database, fileService });
const profiles = createAgentProfileStore({ database });
const agentConfiguration = createNodeAgentConfiguration({ profiles, configurationPath: join(dataDir, "agent-config.json"), fileService });
const secrets = createPersistentSecretBackend({ filePath: join(dataDir, "secrets.vault"), encryptionKey: process.env.NODE_SECRET_ENCRYPTION_KEY, fileService });
const codexBaseUrl = process.env.OPENAI_BASE_URL?.replace(/\/$/, "");
const codexCredential = process.env.OPENAI_API_KEY;
if (codexCredential && !secrets.get("env:OPENAI_API_KEY")) secrets.set("env:OPENAI_API_KEY", codexCredential);
if (codexBaseUrl && codexCredential) {
  const current = profiles.getById("architecture-manager");
  const gatewayUrl = codexBaseUrl.endsWith("/responses")
    ? codexBaseUrl
    : codexBaseUrl.endsWith("/v1") ? `${codexBaseUrl}/responses` : `${codexBaseUrl}/v1/responses`;
  if (!current) profiles.create({ agent_id: "architecture-manager", agent_name: "Architecture Manager", gateway_url: gatewayUrl, credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "configured", provider: "codex", model: process.env.NODE_AGENT_MODEL ?? "gpt-5.6-terra", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  else if (current.gateway_url.includes("gateway.example.test") || current.credential_ref.startsWith("runtime:")) profiles.update({ ...current, gateway_url: gatewayUrl, credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "configured", provider: current.provider ?? "codex", model: current.model ?? process.env.NODE_AGENT_MODEL ?? "gpt-5.6-terra", updated_at: new Date().toISOString() });
}
for (const existing of profiles.getAll()) {
  if (existing.provider === undefined || existing.model === undefined) {
    profiles.update({ ...existing, provider: existing.provider ?? "codex", model: existing.model ?? "", updated_at: existing.updated_at });
  }
}
agentConfiguration.sync();
const agentGateway = createAgentGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference), timeoutMs: Number(process.env.NODE_AGENT_TIMEOUT_MS ?? 60000) });
const agentSettings = createAgentSettingsService({ profiles, configuration: agentConfiguration, gateway: agentGateway, secretStore: secrets });
const bus = createAgentCommunicationBus({ store: communications });
const decisions = createArchitectureDecisionStore({ database });
const roadmaps = createRoadmapStore({ database });
const knowledge = createArchitectureKnowledgeModel({ decisions });
const sprintPlans = createSprintPlanProjection({ roadmaps });
const provenance = createTicketProvenanceTracker({ roadmaps, decisions });
const eventStore = createPersistentEventStore({ database });
const projectId = process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE";
const taskStore = createTaskStore({ database, projectId });
const subscriptions = createSubscriptionRegistry();
const internalBus = new EventEmitter();
const unifiedStreamOrder = createUnifiedStreamOrderer();
let unifiedMessageSequence = 0;
const eventPublisher = createEventPublisher({ store: eventStore, subscriptions });
const ticketStatusStore = createTicketStatusStore({
  database,
  projectId,
  publisher: eventPublisher,
  onEvent: (event) => {
    internalBus.emit(event.type, event);
    if (event.type === "ticket.status_change" && (event.to === "failed" || event.to === "needs_human_review" || event.details?.error)) {
      logEvent({ timestamp: event.timestamp ?? new Date().toISOString(), event_name: "ticket.status_error", level: "error", status: "failed", message: event.details?.error ?? `Ticket status changed to ${event.to}.`, task_id: event.ticket_id, ticket_id: event.ticket_id, source: "ticket-status-store", error_code: event.details?.error_code ?? (event.to === "needs_human_review" ? "NEEDS_HUMAN_REVIEW" : "TICKET_FAILED"), payload: { ...event } });
    }
  }
});
const verificationOrchestrator = createVerificationOrchestrator({ projectRoot: process.cwd(), projectId });
// FileService is created before stores so runtime append writers share one queue.
testService = createTestService({ verificationOrchestrator, fileService, projectRoot: process.cwd(), publisher: eventPublisher, internalBus });
const history = createHistoryStore({ subscriptions });
const summaries = createTaskSummaryStore({ history });
const memory = createProjectMemoryStore({ summaries });
const memoryRetriever = createMemoryRetriever({ memory });
const contextEngine = createContextEngine({ database: indexDb, projectRoot: process.cwd(), projectId });
const baseContext = createAgentContextService({ memoryRetriever, taskSummaries: summaries, taskStore });
const contextService = createFilesystemAwareContextService({ baseContextService: baseContext, contextEngine, budgetManager: createContextBudgetManager(), maxFacts: Number(process.env.NODE_AGENT_MAX_FACTS ?? 200), debug: (detail) => process.env.NODE_DEBUG_CONTEXT && console.debug(detail) });
const agentRuntime = createAgentRuntime({ contextService, budgetManager: createContextBudgetManager(), planningEngine: createPlanningEngine(), publisher: eventPublisher, summaries, memory, maxFacts: Number(process.env.NODE_AGENT_MAX_FACTS ?? 200) });
const runtimeService = createRuntimeService({
  sessionStore: createAgentSessionStore({ database }),
  eventStore,
  memoryRetriever,
  taskStore,
  agentRuntime,
  publisher: eventPublisher
});
const sprintOrchestration = createSprintOrchestrationService({ runtimeService, sprintPlans, sprintPlanStore: roadmaps, ticketProvenanceTracker: provenance, agentGateway, publisher: eventPublisher });
const ticketCommandParser = createTicketCommandParser({ roadmapStore: roadmaps });
const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
const stage1RequestBuilder = createStage1TaskRequestBuilder({ conventions: [
  "Use the NodeForge Code Index before requesting context.",
  "Use File Service for every file read/write and keep changes within the ticket scope.",
  "Return submit_code_response tool with complete full contents and module_system: esm."
] });
const sprintPlanUpload = createSprintPlanUploadService({ roadmaps, projectRoot: process.cwd(), isRunning: (sprintId) => sprintOrchestration.isRunning(sprintId) });
const buildBuilderContext = async ({ message }) => {
  const ticketId = message.payload.text.match(/\b[A-Z][A-Z0-9]+-[A-Z0-9]+-T\d+\b/i)?.[0];
  if (!ticketId) return "";
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id.toLowerCase() === ticketId.toLowerCase());
  if (!ticket) return "";
  const targetPath = canonicalizeAgentPath(ticket.commit?.target_path ?? ticket.target_path ?? ticket.commit_target_path);
  const sections = [`Ticket ${ticket.id}: ${ticket.title ?? ""}`, ticket.objective ? `Objective: ${ticket.objective}` : ""];
  if (targetPath) {
    try {
      if (!indexDb.all("SELECT path FROM files WHERE path = ?", [targetPath]).length) throw new Error(`Indexed file not found: ${targetPath}`);
      const pack = await contextEngine.build({ task_id: ticket.id, line_ranges: [{ path: targetPath, start_line: 1, end_line: 2147483647 }], include_dependencies: true, agent_role: "builder" });
      for (const file of pack.files ?? []) if (file.content) sections.push(`File ${file.path}:\n${file.content}`);
    } catch {
      // Missing or stale context is reported by the tool loop; never bypass the index.
    }
  }
  return sections.filter(Boolean).join("\n\n");
};

function isTestSourcePath(path) { return /^(?:tests|backend\/tests|ui\/tests|ui\/nextjs\/tests)(\/|$)/.test(path); }
function canonicalizeAgentPath(path) {
  if (typeof path !== "string") return path;
  return path.replace(/^src\/backend\/project\/tasks\//, "backend/src/modules/projects/")
    .replace(/^src\/backend\//, "backend/src/")
    .replace(/^src\/web\//, "web/");
}

const protocolLogger = createProtocolStepLogger({ logger: {
  info: (_message, record) => logEvent({ event_name: `protocol.${record.event}`, level: "info", timestamp: record.timestamp, status: record.status === "failed" ? "failed" : "info", message: `Node-Agent protocol ${record.event}.`, task_id: record.task_id, conversation_id: record.conversation_id, source: "protocol-step-logger", ...(record.error_code ? { error_code: record.error_code } : {}), payload: record }),
  error: (_message, record) => logEvent({ event_name: `protocol.${record.event}`, level: "error", timestamp: record.timestamp, status: record.status === "failed" ? "failed" : "info", message: record.error_message ?? `Node-Agent protocol ${record.event}.`, task_id: record.task_id, conversation_id: record.conversation_id, source: "protocol-step-logger", ...(record.error_code ? { error_code: record.error_code } : {}), payload: record })
} });
const stage1GitService = createGitService({ projectRoot: process.cwd() });
const stage1ReportService = createStage1ReportService({ protocolStorage, fileService, gitService: stage1GitService });
const stage1VerificationGate = createStage1VerificationGate({ verificationOrchestrator, gitService: stage1GitService, statusStore: ticketStatusStore, protocolStorage, onStatusChange: ({ projectId, ticketId, status, error }) => roadmaps.updateTicketStatus({ projectId, ticketId, status, error }) });
const stage1TicketRunner = createStage1TicketRunner({ statusStore: ticketStatusStore, gitService: stage1GitService, verificationGate: stage1VerificationGate, reportService: stage1ReportService, protocolLogger, protocolStorage, fileService, files: createFileRepository(indexDb), fileGraph, relevantTreeSelector, requestBuilder: stage1RequestBuilder, agentGateway, resolveAgentProfile: (agentId) => profiles.getById(agentId), onStatusChange: ({ projectId, ticketId, status, error }) => roadmaps.updateTicketStatus({ projectId, ticketId, status, error }) });
const ticketRunner = async ({ projectId, ticketId, conversationId = "CONV-BUILDER" } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  const runtimeStatus = ticketStatusStore.get(ticketId);
  if (["planned", "failed", "needs_human_review"].includes(ticket.status) || ["failed", "needs_human_review"].includes(runtimeStatus?.status)) await protocolStorage.clearTask(ticketId);
  const message = { project_id: projectId, conversation_id: conversationId, correlation_id: `CORR-UI-RUN-${ticketId}-${Date.now()}` };
  void stage1TicketRunner.run(ticket, { conversationId, correlationId: message.correlation_id }).catch((error) => console.error(`[stage1-ticket] ${ticketId}: ${error.message}`));
  return { ticket_id: ticketId, status: "accepted", pipeline: "stage1" };
};
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus, projectLogger: logEvent, internalBus, ticketCommandParser, proseTicketService, buildAgentContext: buildBuilderContext, protocolStorage, debug: (detail) => console.log(`[agent-loop] ${JSON.stringify(detail)}`), dispatchAgentTicket: ({ ticket, message }) => stage1TicketRunner.run(ticket, { conversationId: message.conversation_id, correlationId: message.correlation_id }).catch((error) => console.error(`[stage1-ticket] ${ticket.id}: ${error.message}`)), agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion }),
  // Live SSE must send headers immediately. Scanning the rotating project log
  // on every connection can block the response on network filesystems; replay
  // is already available from the communication/event stores.
  conversationStream: createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions }),
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, relevantTreeSelector, logReader: ({ ticket_id }) => readLogEvents({ project_id: process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE", ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  humanDecisionService: createHumanDecisionService({ decisions, bus }),
  agentSettingsService: agentSettings,
  sprintPlanUploadService: sprintPlanUpload,
  sprintOrchestrationService: sprintOrchestration,
  ticketRunner
});

function publishUnifiedStreamEvent(event) {
  const ordered = unifiedStreamOrder.assign(event);
  internalBus.emit(ordered.event_type, ordered);
  internalBus.emit("event", ordered);
  const conversationId = ordered.payload?.conversation_id;
  if (!conversationId) return ordered;
  // Persist the same unified event on the communication bus so the conversation
  // SSE delivers successes and failures alike, including provider errors.
  try {
    bus.send({
      id: `MSG-UNIFIED-${ordered.task_id ?? "EVENT"}-${Date.now()}-${++unifiedMessageSequence}`,
      project_id: projectId,
      sender: { id: "NODE", role: "node" },
      recipient: { id: "project-owner", role: "project_owner" },
      message_type: ordered.event_type,
      conversation_id: conversationId,
      correlation_id: String(ordered.payload?.correlation_id ?? ordered.task_id ?? `UNIFIED-${unifiedMessageSequence}`),
      payload: { ...ordered.payload, task_id: ordered.task_id, sequence: ordered.sequence },
      timestamp: ordered.timestamp
    });
  } catch (error) {
    // Keep delivery failures queryable even though one malformed event must not
    // terminate the Control API or interrupt later stream events.
    const detail = String(error?.message ?? error).slice(0, 2000);
    try {
      logEvent({
        timestamp: new Date().toISOString(),
        event_name: "system.delivery_error",
        level: "error",
        status: "failed",
        message: `Unified stream delivery failed: ${detail}`,
        task_id: ordered.task_id ?? "UNIFIED-STREAM",
        ticket_id: ordered.payload?.ticket_id,
        conversation_id: conversationId,
        source: "start-control-api",
        error_code: "STREAM_DELIVERY_FAILED",
        payload: { event_type: ordered.event_type, message: detail, conversation_id: conversationId }
      });
    } catch (logError) {
      console.error(`[unified-stream] delivery failed: ${detail}; log failed: ${logError.message}`);
    }
  }
  return ordered;
}

function canonicalizeStage1Tool(toolUse = {}) {
  const input = toolUse?.input && typeof toolUse.input === "object" ? toolUse.input : {};
  const name = toolUse?.name;
  if (name === "code_needed") return { ...input, kind: "request_info", tool: input.tool ?? "read_file", target_path: input.target_path ?? input.files_requested?.[0] };
  if (name === "submit_code_response") {
    const files = Array.isArray(input.files) ? input.files.map((file) => ({ ...file, target_path: file.target_path ?? file.path, change_format: file.change_format ?? file.format })) : input.files;
    return { ...input, kind: "submit_code", files, target_path: input.target_path ?? files?.[0]?.target_path, content: input.content ?? files?.[0]?.content, change_format: input.change_format ?? files?.[0]?.change_format, module_system: input.module_system ?? files?.[0]?.module_system };
  }
  return { ...input, kind: input.kind ?? name };
}

function ticketPrompt(ticket, acceptance, dependencies) {
  return `Ticket ${ticket.id}: ${ticket.title}\nObjective: ${ticket.objective}\nAcceptance criteria:\n${acceptance || "- Follow the objective."}\nDependencies: ${dependencies}\n\nSubmission format: return submit_code_response tool with a concrete target_path, module_system=esm, change_format=full, and the complete content of every submitted file. Do not return unified diff or apply_patch syntax.`;
}

function ticketRequestPayload({ taskId, conversationId, ticket, text }) {
  const envelope = stage1RequestBuilder.buildTaskRequest(ticket, {
    agentId: "builder",
    conversationId,
    correlationId: `CORR-${taskId}`,
    stepId: 1
  });
  const userBlocks = envelope.payload.user_blocks.map((block, index) => index === 0 ? { ...block, content: `${block.content}\n\n${text}` } : block);
  return { ...envelope.payload, user_blocks: userBlocks, request_id: envelope.request_id };
}
const server = api.createServer().listen(port, host, () => {
  process.stdout.write(`Node Control API listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(async () => {
    await indexDb.close();
    await controlDb.close();
    processLock.release();
    process.exit(0);
  }));
}
