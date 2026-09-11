import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";
import { createForgeV1Router } from "../src/transport/http/forge-v1-router.js";

export function createControlApiHttp({ services } = {}) {
  const { runtimeService, bus, communications, eventStore, subscriptions, knowledge, roadmaps, sprintPlans, provenance, relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, dispatchSprint, dispatchTicket, internalBus, ticketCommandParser, proseTicketService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent, dispatchTask, logEvent, projectId } = services;
  const ownerChatService = createOwnerChatService({ bus, projectLogger: logEvent, internalBus, ticketCommandParser, proseTicketService, buildAgentContext: buildBuilderContext, protocolStorage, debug: (detail) => console.log(`[agent-loop] ${JSON.stringify(detail)}`), dispatchAgentTicket: dispatchTask, agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion });
  const conversationStream = createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions });
  return createHttpApi({
    runtimeService,
    ownerChatService,
    conversationStream,
    architectureWorkspaceService: services.architectureWorkspaceService,
    projectDashboardService: services.projectDashboardService,
    conversationAuditHistoryService: services.conversationAuditHistoryService,
    humanDecisionService: services.humanDecisionService,
    agentSettingsService: agentSettings,
    sprintPlanUploadService: sprintPlanUpload,
    sprintOrchestrationService: sprintOrchestration,
    dispatchSprint,
    dispatchTicket,
    forgeV1Router: createForgeV1Router({
      dispatchTicket,
      dispatchSprint,
      projectDashboardService: services.projectDashboardService,
      sprintPlanUploadService: sprintPlanUpload,
      ownerChatService,
      conversationAuditHistoryService: services.conversationAuditHistoryService,
      architectureWorkspaceService: services.architectureWorkspaceService,
      humanDecisionService: services.humanDecisionService,
      agentSettingsService: agentSettings
    })
  });
}
