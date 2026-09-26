import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";
import { createForgeV1Router } from "../src/transport/http/forge-v1-router.js";
import { createProjectStream } from "../src/transport/sse/project-stream.js";
import { createWatcherSnapshotService } from "../src/modules/watcher/watcher-snapshot-service.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { createOwnerSdkStream } from "../src/application/owner-sdk-stream.js";

export function createControlApiHttp({ services } = {}) {
  const { bus, communications, conversations, eventStore, indexDb, subscriptions, knowledge, roadmaps, sprintPlans, provenance, relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, dispatchSprint, dispatchTicket, runToolLab, internalBus, proseTicketService, ticketCrudService, buildBuilderContext, protocolStorage, agentGateway, agentConfiguration, sdkGateways, conversationStateStore, fileService, projectRoot, publishUnifiedStreamEvent, dispatchTask, logEvent, projectId } = services;
  const agentLoopLogger = createRuntimeLogger({ logEvent, source: "owner-chat-agent-loop" });
  const sdkStream = createOwnerSdkStream({ agentConfiguration, sdkGateways, fallbackStream: (input) => agentGateway.stream(input), conversationStateStore, conversationMessages: communications, fileService, projectRoot, projectLogger: agentLoopLogger.emit });
  const ownerChatService = createOwnerChatService({ bus, projectLogger: logEvent, internalBus, buildAgentContext: buildBuilderContext, protocolStorage, conversationCrudService: conversations, debug: (detail) => agentLoopLogger.emit({ event_name: detail?.event ?? "agent.loop", level: detail?.event === "project-log.error" ? "error" : "debug", status: "info", message: detail?.event ?? "Agent loop debug event.", task_id: detail?.task_id, correlation_id: detail?.correlation_id, payload: detail }), agentStream: ({ agentId, payload, correlationId, conversationId }) => sdkStream({ agentId, payload, correlationId, conversationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion });
  const conversationStream = createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions });
  const projectStream = createProjectStream({ projectId, watcherSnapshot: createWatcherSnapshotService({ indexDb }), subscriptions, eventBus: internalBus, bus });
  return createHttpApi({
    ownerChatService,
    conversationStream,
    projectStream,
    architectureWorkspaceService: services.architectureWorkspaceService,
    projectDashboardService: services.projectDashboardService,
    conversationAuditHistoryService: services.conversationAuditHistoryService,
    humanDecisionService: services.humanDecisionService,
    agentSettingsService: agentSettings,
    sprintPlanUploadService: sprintPlanUpload,
    sprintOrchestrationService: sprintOrchestration,
    dispatchSprint,
    dispatchTicket,
    runToolLab,
    forgeV1Router: createForgeV1Router({
      dispatchTicket,
      dispatchSprint,
      runToolLab,
      projectDashboardService: services.projectDashboardService,
      sprintPlanUploadService: sprintPlanUpload,
      ticketCrudService,
      ownerChatService,
      conversationAuditHistoryService: services.conversationAuditHistoryService,
      conversationCrudService: conversations,
      architectureWorkspaceService: services.architectureWorkspaceService,
      humanDecisionService: services.humanDecisionService,
      agentSettingsService: agentSettings,
      listResumableCheckpoints: services.listResumableCheckpoints
      ,projectStream
    })
  });
}
