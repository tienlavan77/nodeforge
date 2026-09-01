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
import { createTicketStatusStore } from "../src/modules/projects/ticket-status-store.js";
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
import { createProtocolStorage } from "../src/infrastructure/storage/protocol-storage.js";
import { createGitService } from "../src/infrastructure/git/git-service.js";
import { dispatchChange } from "../src/application/dispatch-change.js";
import { createExecutionContext } from "../src/application/execution-layer.js";
import { createUnifiedStreamOrderer } from "../src/modules/events/unified-stream-order.js";
import { createTicketCommandParser } from "../src/application/ticket-command-parser.js";
import { createProseTicketService } from "../src/application/prose-ticket-service.js";
import { createStage1TaskRequestBuilder } from "../src/modules/workflows/stage1-task-request-builder.js";
import { createStage1TicketRunner } from "../src/modules/workflows/stage1-ticket-runner.js";
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
const ticketStatusStore = createTicketStatusStore({ database, projectId, publisher: eventPublisher, onEvent: (event) => internalBus.emit(event.type, event) });
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
const runGit = promisify(execFile);
const executeAgentTool = async (tool, { message, eventSink }) => {
  const requestedPath = canonicalizeAgentPath(tool.target_path);
  if (tool.kind === "request_info") {
    if (tool.tool === "read_file") {
      assertAgentSourcePath(requestedPath);
      try {
        if (!indexDb.all("SELECT path FROM files WHERE path = ?", [requestedPath]).length) throw new Error(`Indexed file not found: ${requestedPath}`);
        const pack = await contextEngine.build({ task_id: message.payload.task?.id ?? message.id, line_ranges: [{ path: requestedPath, start_line: 1, end_line: 2147483647 }], include_dependencies: false, agent_role: message.recipient.id });
        const serialized = JSON.stringify(pack);
        return { status: "context_ready", context_available: true, next_step: "submit_code", source: "index", content: serialized, token_usage: { input_tokens: 0, output_tokens: Math.ceil(serialized.length / 4) } };
      } catch (error) {
        if (!/indexed file not found|no such file|not found/i.test(error?.message ?? "")) return contextFailure(requestedPath, error);
        return {
          status: "context_missing",
          context_available: false,
          next_step: "submit_code",
          source: "index",
          requested_path: requestedPath,
          content: `Index không có file: ${requestedPath}. Không đọc trực tiếp filesystem. Hãy dùng list_files/context để kiểm tra path hợp lệ; nếu yêu cầu cần file mới, có thể tạo file tại path này bằng submit_code.`
        };
      }
    }
    if (tool.tool === "list_files") {
      const requested = requestedPath && requestedPath !== "." ? requestedPath : null;
      if (requested) assertAgentSourcePath(requested, { directory: true });
      const paths = requested ? await fileService.listFiles({ glob: requested }) : await listAgentFiles();
      return { status: "context_ready", context_available: true, next_step: "submit_code", content: paths.slice(0, 500).join("\n") };
    }
    if (requestedPath) {
      assertAgentSourcePath(requestedPath);
      try {
        const pack = await contextEngine.build({ task_id: message.payload.task?.id ?? message.id, paths: [requestedPath], include_dependencies: true, agent_role: message.recipient.id });
        const content = JSON.stringify(pack);
        return { status: "context_ready", context_available: true, next_step: "submit_code", source: "index", content, token_usage: { input_tokens: 0, output_tokens: Math.ceil(content.length / 4) } };
      } catch (error) {
        return contextFailure(requestedPath, error);
      }
    }
    const context = await contextService.buildContext({ projectId: message.project_id, taskId: message.payload.task?.id ?? message.id, query: tool.query ?? "" });
    let content = (context.projectFacts ?? []).join("\n");
    if (!content) {
      const task = message.payload.task;
      const taskSummary = task ? `Task ${task.id}: ${task.title}\nObjective: ${task.objective}\nAcceptance criteria:\n${(task.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n")}` : message.payload.text;
    const files = (await listAgentFiles()).slice(0, 200).join("\n");
      content = `${taskSummary}\n\nRepository files:\n${files}`;
    }
    return { status: "context_ready", context_available: true, next_step: "submit_code", content, token_usage: { input_tokens: 0, output_tokens: Math.ceil(content.length / 4) } };
  }
  if (tool.kind === "submit_code") {
    console.log(`[agent-loop] submit_code.received ${JSON.stringify({
      target_path: tool.target_path,
      target_dir: tool.target_dir,
      file_operation: tool.file_operation,
      code_kind: tool.code_kind,
      change_format: tool.change_format ?? null,
      has_content: typeof tool.content === "string",
      content_chars: typeof tool.content === "string" ? tool.content.length : null,
      content_preview: typeof tool.content === "string" ? tool.content.slice(0, 300) : null,
      files_count: Array.isArray(tool.files) ? tool.files.length : 0,
      file_fields: Array.isArray(tool.files) ? tool.files.map((file) => ({
        target_path: file.target_path,
        change_format: file.change_format ?? null,
        has_content: typeof file.content === "string",
        content_chars: typeof file.content === "string" ? file.content.length : null,
        content_preview: typeof file.content === "string" ? file.content.slice(0, 300) : null
      })) : []
    })}`);
    // A multi-file submission carries the actual changes in files[]. Do not
    // prepend the envelope itself as a phantom file (its content may be empty
    // or absent), otherwise dispatchChange fails before valid entries run.
    const files = (Array.isArray(tool.files) && tool.files.length > 0)
      ? tool.files.map((file) => ({ ...file, target_path: canonicalizeAgentPath(file.target_path) }))
      : [{ target_path: canonicalizeAgentPath(tool.target_path), target_dir: tool.target_dir, file_operation: tool.file_operation, code_kind: tool.code_kind, content: tool.content, change_format: tool.change_format, change_summary: tool.change_summary, module_system: tool.module_system, allowed_change_areas: tool.allowed_change_areas }];
    const written = [];
    for (const file of files) {
      assertAgentSourcePath(file.target_path);
      if (file.module_system !== "esm") throw new Error(`Builder ${file.target_path} must declare module_system: esm; use import/export, not require/module.exports.`);
      if ((file.code_kind === "main" && !isMainSourcePath(file.target_path)) || (file.code_kind === "test" && !isTestSourcePath(file.target_path))) throw new Error(`Agent ${file.code_kind} code must stay under ${file.code_kind === "main" ? "backend/src/, backend/scripts/*.mjs, ui/src/, or ui/nextjs/" : "backend/tests/, ui/tests/, or ui/nextjs/tests/"}.`);
      console.log(`[agent-loop] file.write.request ${JSON.stringify({ path: file.target_path, target_dir: file.target_dir, file_operation: file.file_operation, code_kind: file.code_kind, chars: file.content.length })}`);
      try {
        const current = await fileService.readFile({ path: file.target_path }).catch(() => "");
        const checksum = `sha256:${createHash("sha256").update(current).digest("hex")}`;
        const looksLikeUnifiedDiff = /^(?:diff --git |---\s|\+\+\+\s)[\s\S]*^@@\s/m.test(file.content);
        const change = { file_path: file.target_path, checksum_before: checksum, ...(file.change_format === "unified_diff" || file.change_format === "apply_patch" || (!file.change_format && looksLikeUnifiedDiff) ? { diff: file.content } : { content: file.content }) };
        if (typeof change.diff === "string" && /^\s*\*\*\* Begin Patch\b/.test(change.diff)) {
          console.warn(`[agent-loop] unsupported_patch_format ${JSON.stringify({ path: file.target_path, declared_format: file.change_format, detected_format: "apply_patch", expected_format: "unified_diff" })}`);
        }
        console.log(`[agent-loop] dispatch.change ${JSON.stringify({
          file_path: change.file_path,
          selected_format: change.diff !== undefined ? "unified_diff" : "full",
          has_diff: typeof change.diff === "string",
          has_content: typeof change.content === "string",
          content_chars: typeof (change.diff ?? change.content) === "string" ? (change.diff ?? change.content).length : null,
          content_preview: typeof (change.diff ?? change.content) === "string" ? (change.diff ?? change.content).slice(0, 300) : null
        })}`);
        const execution = await dispatchChange(createExecutionContext({ taskId: message.payload.task?.id ?? message.id, ticketId: message.payload.task?.id ?? message.id, conversationId: message.conversation_id, stepId: written.length + 1, change, eventSink, fileService }));
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
function isMainSourcePath(path) {
  return /^(?:src|web\/src|backend\/src|ui\/src|ui\/nextjs\/(?:app|components|lib))(\/|$)/.test(path)
    || /^backend\/scripts\/[^/]+\.mjs$/.test(path);
}
function isTestSourcePath(path) { return /^(?:tests|backend\/tests|ui\/tests|ui\/nextjs\/tests)(\/|$)/.test(path); }
function canonicalizeAgentPath(path) {
  if (typeof path !== "string") return path;
  return path.replace(/^src\/backend\/project\/tasks\//, "backend/src/modules/projects/")
    .replace(/^src\/backend\//, "backend/src/")
    .replace(/^src\/web\//, "web/");
}
function contextFailure(path, error) {
  const message = error?.message ?? "Context lookup failed.";
  const lower = message.toLowerCase();
  if (lower.includes("stale")) return { status: "context_stale", context_available: false, source: "index", requested_path: path, next_step: "request_info", content: `Index stale cho ${path}. Hãy yêu cầu re-index hoặc truy vấn lại context.` };
  if (lower.includes("indexed file not found") || lower.includes("indexed symbol not found") || lower.includes("no such file") || lower.includes("not found")) return { status: "context_missing", context_available: false, source: "index", requested_path: path, next_step: "request_info", content: `Index không có ${path}. Hãy kiểm tra path bằng list_files/context; nếu ticket yêu cầu file mới, có thể tạo bằng submit_code.` };
  if (lower.includes("context request did not match")) return { status: "context_missing", context_available: false, source: "index", requested_path: path, next_step: "request_info", content: `Không tìm thấy dữ liệu index cho ${path}. Hãy chọn file hoặc symbol khác.` };
  if (lower.includes("database") || lower.includes("index")) return { status: "index_unavailable", context_available: false, source: "index", requested_path: path, next_step: "request_info", content: `Index hiện không khả dụng khi truy vấn ${path}; không đọc trực tiếp filesystem. Hãy thử lại sau.` };
  throw error;
}
async function listAgentFiles() {
  const globs = ["src/**/*", "web/src/**/*", "backend/src/**/*", "backend/scripts/*.mjs", "ui/src/**/*", "ui/nextjs/app/**/*", "ui/nextjs/components/**/*", "ui/nextjs/lib/**/*", "tests/**/*", "backend/tests/**/*", "ui/tests/**/*", "ui/nextjs/tests/**/*"];
  return (await Promise.all(globs.map((glob) => fileService.listFiles({ glob })))).flat();
}
function assertAgentSourcePath(path, { directory = false } = {}) {
  if (typeof path !== "string" || !(isMainSourcePath(path) || isTestSourcePath(path)) || path.includes("..")) throw new Error(`Agent path must stay under backend/src/, backend/scripts/*.mjs, ui/src/, ui/nextjs/, or tests/: ${path ?? "<missing>"}`);
  if (directory && path.endsWith("/")) return;
}
const protocolLogger = createProtocolStepLogger({ logger: {
  info: (_message, record) => logEvent({ event_name: `protocol.${record.event}`, level: "info", timestamp: record.timestamp, status: record.status === "failed" ? "failed" : "info", message: `Node-Agent protocol ${record.event}.`, task_id: record.task_id, conversation_id: record.conversation_id, source: "protocol-step-logger", payload: record }),
  error: (_message, record) => logEvent({ event_name: `protocol.${record.event}`, level: "error", timestamp: record.timestamp, status: record.status === "failed" ? "failed" : "info", message: `Node-Agent protocol ${record.event}.`, task_id: record.task_id, conversation_id: record.conversation_id, source: "protocol-step-logger", payload: record })
} });
const stage1TicketRunner = createStage1TicketRunner({ statusStore: ticketStatusStore, gitService: createGitService({ projectRoot: process.cwd() }), protocolLogger, protocolStorage, fileService, files: createFileRepository(indexDb), fileGraph, relevantTreeSelector, requestBuilder: stage1RequestBuilder, agentGateway, resolveAgentProfile: (agentId) => profiles.getById(agentId), onStatusChange: ({ projectId, ticketId, status, error }) => roadmaps.updateTicketStatus({ projectId, ticketId, status, error }) });
const ticketRunner = async ({ projectId, ticketId, conversationId = "CONV-BUILDER" } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  const message = { project_id: projectId, conversation_id: conversationId, correlation_id: `CORR-UI-RUN-${ticketId}-${Date.now()}` };
  void stage1TicketRunner.run(ticket, { conversationId, correlationId: message.correlation_id }).catch((error) => console.error(`[stage1-ticket] ${ticketId}: ${error.message}`));
  return { ticket_id: ticketId, status: "accepted", pipeline: "stage1" };
};
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus, projectLogger: logEvent, internalBus, ticketCommandParser, proseTicketService, buildAgentContext: buildBuilderContext, executeAgentTool, protocolStorage, debug: (detail) => console.log(`[agent-loop] ${JSON.stringify(detail)}`), dispatchAgentTicket: ({ ticket, message }) => stage1TicketRunner.run(ticket, { conversationId: message.conversation_id, correlationId: message.correlation_id }).catch((error) => console.error(`[stage1-ticket] ${ticket.id}: ${error.message}`)), agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion }),
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

function invalidSubmitCodeFormat(tool) {
  if (tool?.kind !== "submit_code") return null;
  const files = Array.isArray(tool.files) && tool.files.length > 0 ? tool.files : [tool];
  for (const file of files) {
    if (file.change_format !== "unified_diff") continue;
    const content = typeof file.content === "string" ? file.content : "";
    if (/^\s*\*\*\* Begin Patch\b/.test(content)) {
      return `${file.target_path}: content is apply_patch format. Return a standard unified diff, not *** Begin Patch.`;
    }
    if (!/(^|\n)---[^\n]*\n\+\+\+/m.test(content)) {
      return `${file.target_path}: unified diff is missing --- and +++ file headers.`;
    }
    if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(content)) {
      return `${file.target_path}: every unified-diff hunk needs line ranges such as @@ -120,3 +120,5 @@; bare @@ is invalid.`;
    }
  }
  return null;
}

function invalidSubmitCodePath(tool) {
  if (tool?.kind !== "submit_code") return null;
  const files = Array.isArray(tool.files) && tool.files.length > 0 ? tool.files : [tool];
  for (const file of files) {
    const path = file?.target_path;
    if (typeof path !== "string" || path.trim() === "" || path === "." || path.endsWith("/")) {
      return `target_path ${JSON.stringify(path ?? null)} is not a file path; provide the exact project-relative file path.`;
    }
  }
  return null;
}

function prepareTicketRuntimeStatus(ticketId) {
  const current = ticketStatusStore.get(ticketId);
  if (!current) { ticketStatusStore.create(ticketId); return; }
  if (["failed", "needs_human_review"].includes(current.status)) { ticketStatusStore.retry(ticketId, { reason: "user_dispatch" }); return; }
  if (current.status === "blocked") ticketStatusStore.updateStatus(ticketId, "pending", { reason: "dependency_recheck" }, { expectedCurrentStatus: "blocked" });
}

function failTicketRuntimeStatus(ticketId, error) {
  const current = ticketStatusStore.get(ticketId);
  if (["running", "reviewing"].includes(current?.status)) ticketStatusStore.updateStatus(ticketId, "failed", { reason: "execution_error", error }, { expectedCurrentStatus: current.status });
}

async function streamTicket({ taskId, ticket, message }) {
  try {
    prepareTicketRuntimeStatus(ticket.id);
    ticketStatusStore.updateStatus(ticket.id, "running", { reason: "dispatch", conversation_id: message.conversation_id }, { expectedCurrentStatus: "pending" });
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "info", status: "info", message: "Ticket dispatch accepted.", task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api", payload: { from: "pending", to: "running", ticket_id: ticket.id, conversation_id: message.conversation_id } });
    roadmaps.updateTicketStatus({ projectId: message.project_id, ticketId: ticket.id, status: "running" });
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "info", status: "info", message: "Ticket is running.", task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api" });
    publishUnifiedStreamEvent({ event_type: "node.status_change", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, from: "pending", to: "running", ticket_id: ticket.id } });
    const acceptance = (ticket.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
    const dependencies = (ticket.dependencies ?? []).join(", ") || "none";
    // Sơ đồ B enters the canonical Node↔Agent pipeline through a validated
    // Stage-1 envelope; the gateway receives only its provider-neutral payload.
    const requestEnvelope = stage1RequestBuilder.buildTaskRequest(ticket, {
      agentId: "builder",
      conversationId: message.conversation_id,
      correlationId: message.correlation_id,
      stepId: 1
    });
    await protocolStorage.save(`task/${ticket.id}/round_1/request`, requestEnvelope, { schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
    let requestPayload = { ...requestEnvelope.payload, request_id: requestEnvelope.request_id };
    let submitted = false;
    let appliedPaths = [];
    const contextFingerprints = new Set();
    let repeatedContextRequests = 0;
    for (let round = 1; round <= 10 && !submitted; round += 1) {
      publishUnifiedStreamEvent({ event_type: "node.message.progress", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, ticket_id: ticket.id, status: "working", round, message: round === 1 ? "Builder đang phân tích ticket và chuẩn bị thay đổi…" : `Builder đang tiếp tục xử lý (vòng ${round})…` } });
      let requestedContext = false;
      // Temporary Stage-1 execution uses one request/response per round. The
      // inner SSE stream is intentionally disabled until the full nine-step
      // protocol loop owns streaming and reconnect semantics.
      const response = await agentGateway.request({ agentId: "builder", correlationId: message.correlation_id, payload: requestPayload, tools: stage1AgentTools });
      for (const chunk of [response?.payload ?? response]) {
        if (!chunk?.tool_use) continue;
        const tool = canonicalizeStage1Tool(chunk.tool_use);
        if (tool.kind === "submit_code" && tool.module_system !== "esm") throw new Error("Builder code must declare module_system: esm; use import/export, not require/module.exports.");
        for (const file of tool.files ?? []) if (file.module_system !== "esm") throw new Error("Every submitted file must declare module_system: esm.");
        const formatError = invalidSubmitCodeFormat(tool);
        const pathError = invalidSubmitCodePath(tool);
        if (pathError) {
          console.warn(`[agent-loop] submit_code.retry ${JSON.stringify({ task_id: taskId, round, reason: pathError })}`);
          publishUnifiedStreamEvent({ event_type: "node.message.progress", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, ticket_id: ticket.id, status: "submit_code_retry", round, message: "Builder gửi target_path không phải file; Node đang yêu cầu gửi lại đường dẫn file cụ thể…" } });
          requestPayload = ticketRequestPayload({ taskId, conversationId: message.conversation_id, ticket, text: `${ticketPrompt(ticket, acceptance, dependencies)}\n\nThe previous submit_code was rejected before writing: ${pathError} Return submit_code again with a concrete file target_path under backend/src/, backend/scripts/*.mjs, ui/src/, ui/nextjs/, or tests/. Do not use . or a directory.` });
          requestedContext = true;
          break;
        }
        if (formatError) {
          console.warn(`[agent-loop] submit_code.retry ${JSON.stringify({ task_id: taskId, round, reason: formatError })}`);
          publishUnifiedStreamEvent({ event_type: "node.message.progress", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, ticket_id: ticket.id, status: "submit_code_retry", round, message: "Builder trả patch chưa đúng định dạng; Node đang yêu cầu gửi lại unified diff chuẩn…" } });
          requestPayload = ticketRequestPayload({
            taskId,
            conversationId: message.conversation_id,
            ticket,
          text: `${ticketPrompt(ticket, acceptance, dependencies)}\n\nThe previous submit_code was rejected before writing any file: ${formatError}\nReturn submit_code again using change_format=full with the complete file content. Do not use unified diff, bare @@, or *** Begin Patch. Preserve target_path and module_system: esm.`
          });
          requestedContext = true;
          break;
        }
        const result = await executeAgentTool(tool, { message: { ...message, payload: { ...message.payload, task: ticket } }, eventSink: publishUnifiedStreamEvent, agentId: "builder" });
        if (tool.kind === "submit_code") {
          appliedPaths = result.paths ?? [];
          submitted = true;
          break;
        }
        if (tool.kind === "request_info") {
          const fingerprint = JSON.stringify({ tool: tool.tool ?? "", target_path: tool.target_path ?? "", query: tool.query ?? "" });
          if (contextFingerprints.has(fingerprint)) repeatedContextRequests += 1;
          contextFingerprints.add(fingerprint);
          publishUnifiedStreamEvent({ event_type: "node.message.progress", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, ticket_id: ticket.id, status: "context_requested", round, message: "Node đang lấy context từ code index…" } });
          requestPayload = ticketRequestPayload({
            taskId,
            conversationId: message.conversation_id,
            ticket,
            text: `${ticketPrompt(ticket, acceptance, dependencies)}\n\nContext status: context_ready\nTool result:\n${String(result.content ?? result).slice(0, 12000)}\n\n${repeatedContextRequests >= 2 ? "Context này đã được cung cấp trước đó. Không được request_info thêm; hãy gửi submit_code_response tool ngay với target_path cụ thể và module_system: esm." : "Next step: submit_code. Return submit_code now."}`
          });
          requestedContext = true;
          break;
        }
      }
      if (!requestedContext && !submitted) {
        publishUnifiedStreamEvent({ event_type: "node.message.progress", task_id: taskId, timestamp: new Date().toISOString(), payload: { conversation_id: message.conversation_id, ticket_id: ticket.id, status: "submit_code_required", round, message: "Builder chưa gửi submit_code; Node đang yêu cầu agent trả code để tiếp tục." } });
        requestPayload = ticketRequestPayload({
          taskId,
          conversationId: message.conversation_id,
          ticket,
          text: `${ticketPrompt(ticket, acceptance, dependencies)}\n\nBắt buộc: vòng trước chưa có submit_code. Hãy trả về submit_code_response tool ngay bây giờ với target_path cụ thể, change_format=full, toàn bộ nội dung file và module_system: esm. Không trả unified diff, bare @@ hoặc *** Begin Patch. Không kết thúc bằng prose hoặc giải thích; chỉ hoàn tất sau khi gửi submit_code.`
        });
      }
    }
    if (!submitted) throw new Error("Builder stream ended without submit_code.");
    ticketStatusStore.updateStatus(ticket.id, "reviewing", { reason: "submit_code", files: appliedPaths }, { expectedCurrentStatus: "running" });
    const gitContext = { task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id };
    const git = createGitService({ projectRoot: process.cwd(), onEvent: ({ type, ...payload }) => {
      const eventPayload = { ...payload, ...gitContext };
      publishUnifiedStreamEvent({ event_type: type, task_id: taskId, timestamp: new Date().toISOString(), payload: eventPayload });
      logEvent({ timestamp: new Date().toISOString(), event_name: type, level: "info", status: "success", message: `${type} succeeded.`, ...gitContext, source: "git-service", payload: eventPayload });
    } });
    const commitResult = await git.commit(`chore: apply ${ticket.id}`, { paths: appliedPaths });
    ticketStatusStore.updateStatus(ticket.id, "done", { reason: "commit", files: appliedPaths, commit: commitResult.sha }, { expectedCurrentStatus: "reviewing" });
    roadmaps.updateTicketStatus({ projectId: message.project_id, ticketId: ticket.id, status: "done" });
    logEvent({ timestamp: new Date().toISOString(), event_name: "ticket.status_change", level: "info", status: "success", message: "Ticket completed.", task_id: taskId, ticket_id: ticket.id, conversation_id: message.conversation_id, source: "start-control-api", payload: { from: "running", to: "done", ticket_id: ticket.id, conversation_id: message.conversation_id, files: appliedPaths, commit: commitResult.sha } });
  } catch (error) {
    const reason = error?.code === "RATE_LIMITED" || error?.statusCode === 429 ? "rate_limited" : "provider_error";
    const errorMessage = String(error?.message ?? error);
    const errorCode = error?.code ?? (error?.statusCode === 429 ? "HTTP_429" : "UPSTREAM_ERROR");
    const detail = `${reason} (${errorCode}): ${errorMessage}`;
    failTicketRuntimeStatus(ticket.id, detail);
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
