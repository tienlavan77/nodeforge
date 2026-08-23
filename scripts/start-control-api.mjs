import process from "node:process";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";

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
import { createSubscriptionRegistry } from "../src/modules/events/subscription-registry.js";
import { createEventPublisher } from "../src/modules/events/event-publisher.js";
import { createHistoryStore } from "../src/modules/history/history-store.js";
import { createTaskSummaryStore } from "../src/modules/history/task-summary-store.js";
import { createProjectMemoryStore } from "../src/modules/history/project-memory-store.js";
import { createProjectFileTool } from "../src/modules/agent/project-file-tool.js";
import { createSprintPlanUploadService } from "../src/application/sprint-plan-upload-service.js";
import { createSprintOrchestrationService } from "../src/application/sprint-orchestration-service.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createTestService } from "../src/application/test-service.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createUnifiedStreamOrderer } from "../src/modules/events/unified-stream-order.js";
import { createTicketCommandParser } from "../src/application/ticket-command-parser.js";

const port = Number(process.env.NODE_CONTROL_PORT ?? 3100);
const host = process.env.NODE_CONTROL_HOST ?? "127.0.0.1";
const runtimeRoot = join(process.cwd(), ".forge", "runtime");
const dataDir = process.env.NODE_CONTROL_DATA_DIR ?? join(runtimeRoot, "nf");
// Keep UI-control persistence isolated from the repository index database.
const processLock = acquireProcessLock(dataDir, "control");
// Control DB (.forge/runtime/nf) — chats, agents, sessions, events
const controlDb = await createDatabaseService({ dataDir, runtimeDir: "." });
// Index DB (.forge/runtime/wc/index.db) — watcher/indexer/context sharing
// Project index uses the same queued DatabaseService as the watcher. Reads stay
// parallel under WAL, while all index mutations are serialized through `write`.
const indexDb = await createDatabaseService({ dataDir: process.cwd(), runtimeDir: join(".forge", "runtime", "wc") });
const database = controlDb;
const communications = createAgentCommunicationStore({ database });
const profiles = createAgentProfileStore({ database });
const agentConfiguration = createNodeAgentConfiguration({ profiles, configurationPath: join(dataDir, "agent-config.json") });
const secrets = createPersistentSecretBackend({ filePath: join(dataDir, "secrets.vault"), encryptionKey: process.env.NODE_SECRET_ENCRYPTION_KEY });
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
const eventPublisher = createEventPublisher({ store: eventStore, subscriptions });
const verificationOrchestrator = createVerificationOrchestrator({ projectRoot: process.cwd(), projectId });
let testService;
const fileService = createFileService({
  projectRoot: process.cwd(),
  databaseService: database,
  onWrite: async ({ path }) => {
    // The watcher owns the complete write -> index -> verification pipeline.
    // Run a focused test immediately only when the submitted path is itself a test;
    // source writes are verified after watcher/indexer processing.
    if (!testService || !path.startsWith("tests/")) return;
    const result = await testService.runTests({ commitId: `FILE-${path}-${Date.now()}`, levels: ["unit_test"], taskId: path });
    if (result.status !== "passed" || result.ready_for_review !== true) {
      throw new Error(`Verification failed for ${path}: ${result.status}`);
    }
    return result;
  }
});
testService = createTestService({ verificationOrchestrator, fileService, projectRoot: process.cwd(), publisher: eventPublisher, internalBus });
const history = createHistoryStore({ subscriptions });
const summaries = createTaskSummaryStore({ history });
const memory = createProjectMemoryStore({ summaries });
const memoryRetriever = createMemoryRetriever({ memory });
const contextEngine = createContextEngine({ database: indexDb, projectRoot: process.cwd(), projectId });
const baseContext = createAgentContextService({ memoryRetriever, taskSummaries: summaries, taskStore });
const contextService = createFilesystemAwareContextService({ baseContextService: baseContext, contextEngine, budgetManager: createContextBudgetManager(), maxFacts: Number(process.env.NODE_AGENT_MAX_FACTS ?? 200), debug: (detail) => process.env.NODE_DEBUG_CONTEXT && console.debug(detail) });
const fileTool = createProjectFileTool({ projectRoot: process.cwd(), fileService });
const agentRuntime = createAgentRuntime({ contextService, budgetManager: createContextBudgetManager(), planningEngine: createPlanningEngine(), publisher: eventPublisher, summaries, memory, maxFacts: Number(process.env.NODE_AGENT_MAX_FACTS ?? 200), executeStep: (step, { task }) => step.type === "implementation" ? fileTool.writeFromQuery(task.title) : undefined });
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
const sprintPlanUpload = createSprintPlanUploadService({ roadmaps, projectRoot: process.cwd(), isRunning: (sprintId) => sprintOrchestration.isRunning(sprintId) });
const buildBuilderContext = async ({ message }) => {
  const ticketId = message.payload.text.match(/\b[A-Z][A-Z0-9]+-[A-Z0-9]+-T\d+\b/i)?.[0];
  if (!ticketId) return "";
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id.toLowerCase() === ticketId.toLowerCase());
  if (!ticket) return "";
  const targetPath = ticket.commit?.target_path ?? ticket.target_path ?? ticket.commit_target_path;
  const sections = [`Ticket ${ticket.id}: ${ticket.title ?? ""}`, ticket.objective ? `Objective: ${ticket.objective}` : ""];
  if (targetPath) {
    try {
      const pack = await contextEngine.build({ task_id: ticket.id, paths: [targetPath], include_dependencies: true, agent_role: "builder" });
      for (const file of pack.files ?? []) if (file.content) sections.push(`File ${file.path}:\n${file.content}`);
    } catch {
      // The index can lag behind a newly uploaded ticket; read the guarded path directly.
      try { sections.push(`File ${targetPath}:\n${await fileService.readFile({ path: targetPath })}`); } catch { /* guarded best effort */ }
    }
  }
  return sections.filter(Boolean).join("\n\n");
};
const executeAgentTool = async (tool, { message }) => {
  if (tool.kind === "request_info") {
    if (tool.tool === "read_file") {
      assertAgentSourcePath(tool.target_path);
      return { status: "context_ready", context_available: true, next_step: "submit_code", content: await fileService.readFile({ path: tool.target_path }) };
    }
    if (tool.tool === "list_files") {
      const requested = tool.target_path && tool.target_path !== "." ? tool.target_path : null;
      if (requested) assertAgentSourcePath(requested, { directory: true });
      const paths = requested ? await fileService.listFiles({ glob: requested }) : [...await fileService.listFiles({ glob: "src/**/*" }), ...await fileService.listFiles({ glob: "tests/**/*" })];
      return { status: "context_ready", context_available: true, next_step: "submit_code", content: paths.slice(0, 500).join("\n") };
    }
    if (tool.target_path) {
      const pack = await contextEngine.build({ task_id: message.payload.task?.id ?? message.id, paths: [tool.target_path], include_dependencies: true, agent_role: message.recipient.id });
      return { status: "context_ready", context_available: true, next_step: "submit_code", content: JSON.stringify(pack), token_usage: { input_tokens: 0, output_tokens: Math.ceil(JSON.stringify(pack).length / 4) } };
    }
    const context = await contextService.buildContext({ projectId: message.project_id, taskId: message.payload.task?.id ?? message.id, query: tool.query ?? "" });
    let content = (context.projectFacts ?? []).join("\n");
    if (!content) {
      const task = message.payload.task;
      const taskSummary = task ? `Task ${task.id}: ${task.title}\nObjective: ${task.objective}\nAcceptance criteria:\n${(task.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n")}` : message.payload.text;
      const files = [...await fileService.listFiles({ glob: "src/**/*" }), ...await fileService.listFiles({ glob: "tests/**/*" })].slice(0, 200).join("\n");
      content = `${taskSummary}\n\nRepository files:\n${files}`;
    }
    return { status: "context_ready", context_available: true, next_step: "submit_code", content, token_usage: { input_tokens: 0, output_tokens: Math.ceil(content.length / 4) } };
  }
  if (tool.kind === "submit_code") {
    const files = [{ target_path: tool.target_path, target_dir: tool.target_dir, file_operation: tool.file_operation, code_kind: tool.code_kind, content: tool.content, allowed_change_areas: tool.allowed_change_areas }, ...(tool.files ?? [])];
    const written = [];
    for (const file of files) {
      assertAgentSourcePath(file.target_path);
      if ((file.code_kind === "main" && !file.target_path.startsWith("src/")) || (file.code_kind === "test" && !file.target_path.startsWith("tests/"))) throw new Error(`Agent ${file.code_kind} code must stay under ${file.code_kind === "main" ? "src/" : "tests/"}.`);
      console.log(`[agent-loop] file.write.request ${JSON.stringify({ path: file.target_path, target_dir: file.target_dir, file_operation: file.file_operation, code_kind: file.code_kind, chars: file.content.length })}`);
      try {
        const result = await fileService.writeFile({ path: file.target_path, content: file.content, commit: { target_path: file.target_path, target_dir: file.target_dir, file_operation: file.file_operation, allowed_change_areas: file.allowed_change_areas } });
        console.log(`[agent-loop] file.write.success ${JSON.stringify({ ...result, code_kind: file.code_kind })}`);
        written.push(result.path);
      } catch (error) {
        console.error(`[agent-loop] file.write.error ${JSON.stringify({ path: file.target_path, error: error.message })}`);
        throw error;
      }
    }
    const chars = files.reduce((sum, file) => sum + file.content.length, 0);
    return { content: `Wrote ${written.join(", ")}`, token_usage: { input_tokens: 0, output_tokens: Math.ceil(chars / 4) } };
  }
  throw new Error("Unsupported agent tool request.");
};
function assertAgentSourcePath(path, { directory = false } = {}) {
  if (typeof path !== "string" || !/^(src|tests)(\/|$)/.test(path) || path.includes("..")) throw new Error(`Agent path must stay under src/ or tests/: ${path ?? "<missing>"}`);
  if (directory && path.endsWith("/")) return;
}
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus, internalBus, ticketCommandParser, buildAgentContext: buildBuilderContext, executeAgentTool, debug: (detail) => console.log(`[agent-loop] ${JSON.stringify(detail)}`), dispatchAgentTicket: ({ task_id: taskId, ticket, message }) => streamTicket({ taskId, ticket, message }), agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion }),
  conversationStream: createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions }),
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore }),
  humanDecisionService: createHumanDecisionService({ decisions, bus }),
  agentSettingsService: agentSettings,
  sprintPlanUploadService: sprintPlanUpload,
  sprintOrchestrationService: sprintOrchestration
});

function publishUnifiedStreamEvent(event) {
  // Unified stream events are forwarded on the internal bus; persistence and SSE
  // fan-out are owned by the streaming ticket that follows this adapter wiring.
  const ordered = unifiedStreamOrder.assign(event);
  internalBus.emit(ordered.event_type, ordered);
  internalBus.emit("event", ordered);
}
async function streamTicket({ taskId, ticket, message }) {
  publishUnifiedStreamEvent({ event_type: "node.status_change", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, from: "pending", to: "running", ticket_id: ticket.id } });
  for await (const chunk of agentGateway.stream({ agentId: "builder", correlationId: message.correlation_id, payload: { task_id: taskId, text: `${ticket.title}: ${ticket.objective}` }, eventSink: publishUnifiedStreamEvent })) {
    if (chunk.text) bus.sendFast({ id: `STREAM-${Date.now()}`, project_id: message.project_id, sender: { id: "NODE", role: "node" }, recipient: message.sender, message_type: "agent.text_stream", conversation_id: message.conversation_id, correlation_id: message.correlation_id, payload: { text: chunk.text, task_id: taskId }, timestamp: new Date().toISOString() });
  }
  publishUnifiedStreamEvent({ event_type: "node.status_change", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, from: "running", to: "done", ticket_id: ticket.id } });
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
