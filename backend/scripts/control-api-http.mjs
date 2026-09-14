import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";
import { createForgeV1Router } from "../src/transport/http/forge-v1-router.js";
import { createProjectStream } from "../src/transport/sse/project-stream.js";
import { createWatcherSnapshotService } from "../src/modules/watcher/watcher-snapshot-service.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";

export function createControlApiHttp({ services } = {}) {
  const { runtimeService, bus, communications, eventStore, indexDb, subscriptions, knowledge, roadmaps, sprintPlans, provenance, relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, dispatchSprint, dispatchTicket, runToolLab, internalBus, ticketCommandParser, proseTicketService, ticketCrudService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent, dispatchTask, logEvent, projectId } = services;
  const agentLoopLogger = createRuntimeLogger({ logEvent, source: "owner-chat-agent-loop" });
  const ownerChatService = createOwnerChatService({ bus, projectLogger: logEvent, internalBus, ticketCommandParser, proseTicketService, buildAgentContext: buildBuilderContext, protocolStorage, debug: (detail) => agentLoopLogger.emit({ event_name: detail?.event ?? "agent.loop", level: detail?.event === "project-log.error" ? "error" : "debug", status: "info", message: detail?.event ?? "Agent loop debug event.", task_id: detail?.task_id, correlation_id: detail?.correlation_id, payload: detail }), dispatchAgentTicket: dispatchTask, agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion });
  const conversationStream = createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions });
  const projectStream = createProjectStream({ projectId, watcherSnapshot: createWatcherSnapshotService({ indexDb }), subscriptions, eventBus: internalBus });
  return createHttpApi({
    runtimeService,
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
      architectureWorkspaceService: services.architectureWorkspaceService,
      humanDecisionService: services.humanDecisionService,
      agentSettingsService: agentSettings
      ,projectStream
    })
  });
}
