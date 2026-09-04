import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";

export function createControlApiHttp({ services } = {}) {
  const { runtimeService, bus, communications, eventStore, subscriptions, knowledge, roadmaps, sprintPlans, provenance, relevantTreeSelector, decisions, agentSettings, sprintPlanUpload, sprintOrchestration, ticketRunner, internalBus, ticketCommandParser, proseTicketService, buildBuilderContext, protocolStorage, agentGateway, publishUnifiedStreamEvent, stage1TicketRunner, logEvent, projectId } = services;
  return createHttpApi({
    runtimeService,
    ownerChatService: createOwnerChatService({ bus, projectLogger: logEvent, internalBus, ticketCommandParser, proseTicketService, buildAgentContext: buildBuilderContext, protocolStorage, debug: (detail) => console.log(`[agent-loop] ${JSON.stringify(detail)}`), dispatchAgentTicket: ({ ticket, message }) => stage1TicketRunner.run(ticket, { conversationId: message.conversation_id, correlationId: message.correlation_id }).catch((error) => console.error(`[stage1-ticket] ${ticket.id}: ${error.message}`)), agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion }),
    conversationStream: createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions }),
    architectureWorkspaceService: services.architectureWorkspaceService,
    projectDashboardService: services.projectDashboardService,
    conversationAuditHistoryService: services.conversationAuditHistoryService,
    humanDecisionService: services.humanDecisionService,
    agentSettingsService: agentSettings,
    sprintPlanUploadService: sprintPlanUpload,
    sprintOrchestrationService: sprintOrchestration,
    ticketRunner
  });
}
