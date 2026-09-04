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
import { createStage1TaskRequestBuilder } from "../src/modules/workflows/stage1-task-request-builder.js";
import { createStage1TicketRunner } from "../src/modules/workflows/stage1-ticket-runner.js";
import { createStage1VerificationGate } from "../src/modules/workflows/stage1-verification-gate.js";
import { createStage1ReportService } from "../src/modules/workflows/stage1-report-service.js";
import { stage1AgentTools } from "../src/modules/workflows/stage1-agent-tools.js";
import { createFileRepository } from "../src/modules/index/file-repository.js";
import { createProtocolStepLogger } from "../src/modules/protocol/protocol-step-logger.js";
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
const { projectId, codeSearch, fileGraph, relevantTreeSelector, communications, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, verificationOrchestrator, contextEngine, runtimeService, sprintOrchestration, ticketCommandParser, proseTicketService, sprintPlanUpload } = platform;
testService = platform.testService;
const unifiedStreamOrder = createUnifiedStreamOrderer();
const stage1RequestBuilder = createStage1TaskRequestBuilder({ conventions: ["Use the NodeForge Code Index before requesting context.", "Use File Service for every file read/write and keep changes within the ticket scope.", "Return submit_code_response using the provided schema and the requested file representation."] });
const buildBuilderContext = createBuilderContext({ roadmaps, indexDb, contextEngine });

const protocolLogger = createProtocolStepLogger({ logger: {
  info: (_message, record) => logEvent({ event_name: `protocol.${record.event}`, level: "info", timestamp: record.timestamp, status: record.status === "failed" ? "failed" : "info", message: `Node-Agent protocol ${record.event}.`, task_id: record.task_id, conversation_id: record.conversation_id, source: "protocol-step-logger", ...(record.error_code ? { error_code: record.error_code } : {}), payload: record }),
  error: (_message, record) => logEvent({ event_name: `protocol.${record.event}`, level: "error", timestamp: record.timestamp, status: record.status === "failed" ? "failed" : "info", message: record.error_message ?? `Node-Agent protocol ${record.event}.`, task_id: record.task_id, conversation_id: record.conversation_id, source: "protocol-step-logger", ...(record.error_code ? { error_code: record.error_code } : {}), payload: record })
} });
const stage1GitService = createGitService({ projectRoot: process.cwd() });
const stage1ReportService = createStage1ReportService({ protocolStorage, fileService, gitService: stage1GitService });
const stage1VerificationGate = createStage1VerificationGate({ verificationOrchestrator, gitService: stage1GitService, statusStore: ticketStatusStore, protocolStorage, onStatusChange: ({ projectId, ticketId, status, error }) => roadmaps.updateTicketStatus({ projectId, ticketId, status, error }) });
const stage1TicketRunner = createStage1TicketRunner({ conversationStateStore, statusStore: ticketStatusStore, gitService: stage1GitService, verificationGate: stage1VerificationGate, reportService: stage1ReportService, protocolLogger, protocolStorage, fileService, files: createFileRepository(indexDb), fileGraph, relevantTreeSelector, requestBuilder: stage1RequestBuilder, agentGateway, resolveAgentProfile: (agentId) => profiles.getById(agentId), onStatusChange: ({ projectId, ticketId, status, error }) => roadmaps.updateTicketStatus({ projectId, ticketId, status, error }) });
const ticketRunner = async ({ projectId, ticketId, conversationId } = {}) => {
  const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
  if (!ticket) { const error = new Error(`Ticket not found: ${ticketId}`); error.statusCode = 404; throw error; }
  const runtimeStatus = ticketStatusStore.get(ticketId);
  if (["planned", "failed", "needs_human_review"].includes(ticket.status) || ["failed", "needs_human_review"].includes(runtimeStatus?.status)) {
    await protocolStorage.clearTask(ticketId);
    await conversationStateStore.clear(conversationId ?? `CONV-BUILDER-${projectId}-${ticketId}`);
  }
  const message = { project_id: projectId, conversation_id: conversationId ?? `CONV-BUILDER-${projectId}-${ticketId}`, correlation_id: `CORR-UI-RUN-${ticketId}-${Date.now()}` };
  void stage1TicketRunner.run(ticket, { conversationId: message.conversation_id, correlationId: message.correlation_id }).catch((error) => console.error(`[stage1-ticket] ${ticketId}: ${error.message}`));
  return { ticket_id: ticketId, status: "accepted", pipeline: "stage1" };
};
const publishUnifiedStreamEvent = createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent });

const api = createControlApiHttp({ services: {
  runtimeService, bus, communications, eventStore, subscriptions, knowledge, roadmaps, sprintPlans, provenance,
  relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, ticketRunner, internalBus,
  ticketCommandParser, proseTicketService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent,
  stage1TicketRunner, logEvent, projectId,
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance, relevantTreeSelector, logReader: ({ ticket_id }) => readLogEvents({ project_id: projectId, ticket_id }) }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore, logReader: ({ project_id, task_id, correlation_id, conversation_id, event_name }) => readLogEvents({ project_id, task_id, ticket_id: task_id, conversation_id, event_name, correlation_id }) }),
  humanDecisionService: createHumanDecisionService({ decisions, bus })
} });

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
startControlApi({ api, port, host, indexDb, controlDb, processLock });
