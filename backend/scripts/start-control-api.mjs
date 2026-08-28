import process from "node:process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { dispatchChange } from "../src/application/dispatch-change.js";
import { createExecutionContext } from "../src/application/execution-layer.js";
import { createUnifiedStreamOrderer } from "../src/modules/events/unified-stream-order.js";
import { createTicketCommandParser } from "../src/application/ticket-command-parser.js";
import { createProseTicketService } from "../src/application/prose-ticket-service.js";
import { logEvent, readLogEvents } from "../src/core/project-log-service.js";

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
let unifiedMessageSequence = 0;
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
      const error = new Error(`Verification failed for ${path}: ${result.status}`);
      error.verificationResult = result;
      throw error;
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
const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
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
const runGit = promisify(execFile);
const executeAgentTool = async (tool, { message, eventSink }) => {
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
    const files = [{ target_path: tool.target_path, target_dir: tool.target_dir, file_operation: tool.file_operation, code_kind: tool.code_kind, content: tool.content, module_system: tool.module_system, allowed_change_areas: tool.allowed_change_areas }, ...(tool.files ?? [])];
    const written = [];
    for (const file of files) {
      assertAgentSourcePath(file.target_path);
      if (file.module_system !== "esm") throw new Error(`Builder ${file.target_path} must declare module_system: esm; use import/export, not require/module.exports.`);
      if ((file.code_kind === "main" && !isMainSourcePath(file.target_path)) || (file.code_kind === "test" && !file.target_path.startsWith("tests/"))) throw new Error(`Agent ${file.code_kind} code must stay under ${file.code_kind === "main" ? "src/ or web/src/" : "tests/"}.`);
      console.log(`[agent-loop] file.write.request ${JSON.stringify({ path: file.target_path, target_dir: file.target_dir, file_operation: file.file_operation, code_kind: file.code_kind, chars: file.content.length })}`);
      try {
        const current = await fileService.readFile({ path: file.target_path }).catch(() => "");
        const checksum = `sha256:${createHash("sha256").update(current).digest("hex")}`;
        const change = { file_path: file.target_path, checksum_before: checksum, ...(file.content.includes("@@") ? { diff: file.content } : { content: file.content }) };
        const execution = await dispatchChange(createExecutionContext({ taskId: message.payload.task?.id ?? message.id, ticketId: message.payload.task?.id ?? message.id, conversationId: message.conversation_id, stepId: written.length + 1, change, eventSink }));
        const finalResult = execution.trace.at(-1);
        if (!finalResult?.success) throw new Error(finalResult?.error_message ?? "Execution apply failed.");
        eventSink?.({ event_type: "node.command_result", task_id: message.payload.task?.id ?? message.id, timestamp: new Date().toISOString(), payload: {
          command_id: `dispatchChange-${message.payload.task?.id ?? message.id}-${written.length + 1}`,
          success: true,
          result: { step_name: finalResult.step_name, success: true, error_code: null, duration_ms: finalResult.duration_ms ?? 0 },
          conversation_id: message.conversation_id
        } });
        console.log(`[agent-loop] file.write.success ${JSON.stringify({ path: file.target_path, code_kind: file.code_kind, execution: finalResult })}`);
        written.push(file.target_path);
      } catch (error) {
        console.error(`[agent-loop] file.write.error ${JSON.stringify({ path: file.target_path, error: error.message })}`);
        throw error;
      }
    }
    const chars = files.reduce((sum, file) => sum + file.content.length, 0);
    return { content: `Wrote ${written.join(", ")}`, paths: written, token_usage: { input_tokens: 0, output_tokens: Math.ceil(chars / 4) } };
  }
  throw new Error("Unsupported agent tool request.");
};
function isMainSourcePath(path) { return /^(src|web\/src)(\/|$)/.test(path); }
function assertAgentSourcePath(path, { directory = false } = {}) {
  if (typeof path !== "string" || !(isMainSourcePath(path) || /^(tests)(\/|$)/.test(path)) || path.includes("..")) throw new Error(`Agent path must stay under src/, web/src/, or tests/: ${path ?? "<missing>"}`);
  if (directory && path.endsWith("/")) return;
}
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus, projectLogger: logEvent, internalBus, ticketCommandParser, proseTicketService, buildAgentContext: buildBuilderContext, executeAgentTool, debug: (detail) => console.log(`[agent-loop] ${JSON.stringify(detail)}`), dispatchAgentTicket: ({ task_id: taskId, ticket, message }) => streamTicket({ taskId, ticket, message }), agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion }),
  // Live SSE must send headers immediately. Scanning the rotating project log
  // on every connection can block the response on network filesystems; replay
  // is already available from the communication/event stores.
  conversationStream: createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions }),
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, logReader: ({ ticket_id }) => readLogEvents({ project_id: process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE", ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  humanDecisionService: createHumanDecisionService({ decisions, bus }),
  agentSettingsService: agentSettings,
  sprintPlanUploadService: sprintPlanUpload,
  sprintOrchestrationService: sprintOrchestration
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
async function streamTicket({ taskId, ticket, message }) {
  try {
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "info", status: "info", message: "Ticket dispatch accepted.", task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api", payload: { from: "pending", to: "running", ticket_id: ticket.id, conversation_id: message.conversation_id } });
    roadmaps.updateTicketStatus({ projectId: message.project_id, ticketId: ticket.id, status: "running" });
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "info", status: "info", message: "Ticket is running.", task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api" });
    publishUnifiedStreamEvent({ event_type: "node.status_change", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, from: "pending", to: "running", ticket_id: ticket.id } });
    const acceptance = (ticket.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
    const dependencies = (ticket.dependencies ?? []).join(", ") || "none";
    let requestPayload = ticketRequestPayload({ taskId, conversationId: message.conversation_id, ticket, text: ticketPrompt(ticket, acceptance, dependencies) });
    let submitted = false;
    let appliedPaths = [];
    for (let round = 1; round <= 10 && !submitted; round += 1) {
      let requestedContext = false;
      for await (const chunk of agentGateway.stream({ agentId: "builder", correlationId: message.correlation_id, payload: requestPayload, eventSink: publishUnifiedStreamEvent })) {
        if (!chunk?.tool_use) continue;
        const tool = chunk.tool_use.input ?? chunk.tool_use;
        if (tool.kind === "submit_code" && tool.module_system !== "esm") throw new Error("Builder code must declare module_system: esm; use import/export, not require/module.exports.");
        for (const file of tool.files ?? []) if (file.module_system !== "esm") throw new Error("Every submitted file must declare module_system: esm.");
        const result = await executeAgentTool(tool, { message: { ...message, payload: { ...message.payload, task: ticket } }, eventSink: publishUnifiedStreamEvent, agentId: "builder" });
        if (tool.kind === "submit_code") {
          appliedPaths = result.paths ?? [];
          submitted = true;
          break;
        }
        if (tool.kind === "request_info") {
          requestPayload = ticketRequestPayload({
            taskId,
            conversationId: message.conversation_id,
            ticket,
            text: `${ticketPrompt(ticket, acceptance, dependencies)}\n\nContext status: context_ready\nTool result:\n${String(result.content ?? result).slice(0, 12000)}\n\nNext step: submit_code. Return submit_code now.`
          });
          requestedContext = true;
          break;
        }
      }
      if (!requestedContext && !submitted) break;
    }
    if (!submitted) throw new Error("Builder stream ended without submit_code.");
    const gitContext = { task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id };
    const { stdout } = await runGitLogged(["status", "--porcelain", "--", ...appliedPaths], "git.status", { ...gitContext, eventSink: publishUnifiedStreamEvent });
    if (!stdout.trim()) throw new Error("No applied changes to commit.");
    await runGitLogged(["add", "--", ...appliedPaths], "git.add", { ...gitContext, eventSink: publishUnifiedStreamEvent });
    const commitResult = await runGitLogged(["commit", "-m", `chore: apply ${ticket.id}`], "git.commit", { ...gitContext, eventSink: publishUnifiedStreamEvent });
    roadmaps.updateTicketStatus({ projectId: message.project_id, ticketId: ticket.id, status: "done" });
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "info", status: "success", message: "Ticket completed.", task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api", payload: { from: "running", to: "done", ticket_id: ticket.id, conversation_id: message.conversation_id, files: appliedPaths, commit: commitResult.commit } });
  } catch (error) {
    const reason = error?.code === "RATE_LIMITED" || error?.statusCode === 429 ? "rate_limited" : "provider_error";
    const errorMessage = String(error?.message ?? error);
    const errorCode = error?.code ?? (error?.statusCode === 429 ? "HTTP_429" : "UPSTREAM_ERROR");
    const detail = `${reason} (${errorCode}): ${errorMessage}`;
    roadmaps.updateTicketStatus({ projectId: message.project_id, ticketId: ticket.id, status: "failed", error: detail });
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "error", status: "failed", message: detail, task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api", payload: { from: "running", to: "failed", ticket_id: ticket.id, conversation_id: message.conversation_id, error: detail } });
    publishUnifiedStreamEvent({ event_type: "node.command_result", task_id: taskId, timestamp: new Date().toISOString(), payload: {
      command_id: `agent-stream-${taskId}`,
      success: false,
      conversation_id: message.conversation_id,
      exit_code: null,
      error_code: errorCode,
      message: detail
    } });
    publishUnifiedStreamEvent({ event_type: "node.status_change", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, from: "running", to: "failed", ticket_id: ticket.id, reason, error_code: errorCode, error: errorMessage, message: detail } });
    try {
      bus.send({ id: `MSG-BUILDER-FAILED-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, project_id: message.project_id, sender: { id: "builder", role: "builder" }, recipient: { id: "NODE", role: "node" }, message_type: "builder.error", conversation_id: message.conversation_id, correlation_id: message.correlation_id, payload: { task_id: taskId, reason, error_code: errorCode, error: errorMessage, message: detail }, timestamp: new Date().toISOString() });
    } catch (deliveryError) {
      console.error(`[builder-error] failed to persist error event: ${deliveryError.message}`);
    }
    return { task_id: taskId, status: "failed", reason };
  }
  publishUnifiedStreamEvent({ event_type: "node.status_change", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, from: "running", to: "done", ticket_id: ticket.id } });
  return { task_id: taskId, status: "done" };
}

async function runGitLogged(args, eventName, context) {
  const started = new Date().toISOString();
  try {
    const result = await runGit("git", args, { cwd: process.cwd() });
    const commit = eventName === "git.commit" ? String(result.stdout ?? "").match(/\b[0-9a-f]{7,40}\b/i)?.[0] : undefined;
    const payload = { message: `${eventName} succeeded.`, conversation_id: context.conversation_id, task_id: context.task_id, ticket_id: context.ticket_id, exit_code: 0, ...(commit ? { commit } : {}) };
    context.eventSink?.({ event_type: eventName, task_id: context.task_id, timestamp: started, payload });
    logEvent({ timestamp: started, event_name: eventName, level: "info", status: "success", message: `${eventName} succeeded.`, task_id: context.task_id, ticket_id: context.ticket_id, conversation_id: context.conversation_id, source: "start-control-api", exit_code: 0, payload });
    return { ...result, commit };
  } catch (error) {
    const parsedCode = Number(error?.code);
    const exitCode = Number.isInteger(parsedCode) ? parsedCode : Number.isInteger(error?.status) ? error.status : null;
    const message = String(error?.stderr || error?.message || "Git operation failed.").replace(/(?:https?:\/\/|ssh\s+)[^\s]+/gi, "[REDACTED]");
    const payload = { message: message.slice(0, 2000), conversation_id: context.conversation_id, task_id: context.task_id, ticket_id: context.ticket_id, exit_code: exitCode, error_code: `GIT_${eventName.split(".").at(-1).toUpperCase()}_FAILED` };
    context.eventSink?.({ event_type: eventName, task_id: context.task_id, timestamp: new Date().toISOString(), payload });
    logEvent({ timestamp: new Date().toISOString(), event_name: eventName, level: "error", status: "failed", message: message.slice(0, 2000), task_id: context.task_id, ticket_id: context.ticket_id, conversation_id: context.conversation_id, source: "start-control-api", exit_code: exitCode, error_code: payload.error_code, payload });
    throw error;
  }
}

function ticketPrompt(ticket, acceptance, dependencies) {
  return `Ticket ${ticket.id}: ${ticket.title}\nObjective: ${ticket.objective}\nAcceptance criteria:\n${acceptance || "- Follow the objective."}\nDependencies: ${dependencies}`;
}

function ticketRequestPayload({ taskId, conversationId, ticket, text }) {
  return { task_id: taskId, conversation_id: conversationId, text, task: ticket };
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
