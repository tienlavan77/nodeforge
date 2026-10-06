import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";
import { createForgeV1Router } from "../src/transport/http/forge-v1-router.js";
import { createProjectStream } from "../src/transport/sse/project-stream.js";
import { createWatcherSnapshotService } from "../src/modules/watcher/watcher-snapshot-service.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { createOwnerSdkStream } from "../src/application/owner-sdk-stream.js";
import { createOwnerExecutionCheckpoint } from "../src/application/owner-execution-checkpoint.js";
import { createOwnerExecutionControl } from "../src/application/owner-execution-control.js";
import { createOwnerChatCommandService } from "../src/application/owner-chat-command-service.js";
import { createPlanHandoffService } from "../src/application/plan-handoff-service.js";
import { createWatcherCacheEvents } from "../src/modules/context/watcher-cache-events.js";

export function createControlApiHttp({ services } = {}) {
  const { bus, communications, conversations, eventStore, indexDb, subscriptions, agentSettings, sprintPlanUpload, sprintOrchestration, sprintPlanLeader, dispatchSprint, dispatchTicket, reviewTicket, runToolLab, directCodeRequest, codeCache, internalBus, ticketCrudService, buildBuilderContext, protocolStorage, agentGateway, agentConfiguration, sdkGateways, conversationStateStore, fileService, planFileService, projectRoot, publishUnifiedStreamEvent, logEvent, projectId, gitService } = services;
  const agentLoopLogger = createRuntimeLogger({ logEvent, source: "owner-chat-agent-loop" });
  const executionCheckpoint = createOwnerExecutionCheckpoint({ fileService, gitService });
  const sdkStream = createOwnerSdkStream({ executionCheckpoint, agentConfiguration, sdkGateways, fallbackStream: (input) => agentGateway.stream(input), conversationStateStore, conversationMessages: communications, fileService, codeCache, codeSearch: services.codeSearch, gitService, testService: services.testService, projectRoot, projectLogger: agentLoopLogger.emit });
  const planHandoff = services.planStore && services.database ? createPlanHandoffService({ projectId, database: services.database, planStore: services.planStore, markdownPlanStore: services.markdownPlanStore, sprintPlanLeader, sprintOrchestration, sprintRegistry: services.sprintRegistry, agentRoleResolver: services.agentRoleResolver }) : null;
  const commandService = services.planStore && (planFileService || services.fileService) ? createOwnerChatCommandService({ projectId, fileService: planFileService || services.fileService, communications, planStore: services.planStore, markdownPlanStore: services.markdownPlanStore, sprintRegistry: services.sprintRegistry, handoffApprovedPlan: ({ plan, conversationId }) => planHandoff.handoff({ plan, conversationId }) }) : null;
  const ownerChatService = createOwnerChatService({ bus, communications, projectLogger: logEvent, internalBus, buildAgentContext: buildBuilderContext, protocolStorage, conversationCrudService: conversations, commandService, debug: (detail) => agentLoopLogger.emit({ event_name: detail?.event ?? "agent.loop", level: detail?.event === "project-log.error" ? "error" : "debug", status: "info", message: detail?.event ?? "Agent loop debug event.", task_id: detail?.task_id, correlation_id: detail?.correlation_id, payload: detail }), agentStream: ({ agentId, payload, correlationId, conversationId }) => sdkStream({ agentId, payload, correlationId, conversationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion });
  const ownerExecutionControl = createOwnerExecutionControl({ checkpoint: executionCheckpoint, sdkStream, ownerChatService, communications, agentConfiguration });
  const conversationStream = createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions });
  const projectStream = createProjectStream({ projectId, watcherSnapshot: createWatcherSnapshotService({ indexDb }), subscriptions, eventBus: internalBus, bus });
  const onWatcherEvent = createWatcherCacheEvents({ projectId, codeCache, logger: agentLoopLogger.emit });
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
    reviewTicket,
    runToolLab,
    forgeV1Router: createForgeV1Router({
      dispatchTicket,
      dispatchSprint,
      sprintOrchestrationService: sprintOrchestration,
      reviewTicket,
      ticketHumanReviewService: services.ticketHumanReviewService,
      runToolLab,
      directCodeRequest,
      onWatcherEvent,
      projectDashboardService: services.projectDashboardService,
      sprintPlanUploadService: sprintPlanUpload,
      ticketCrudService,
      ownerChatService,
      ownerExecutionControl,
      conversationAuditHistoryService: services.conversationAuditHistoryService,
      conversationCrudService: conversations,
      architectureWorkspaceService: services.architectureWorkspaceService,
      humanDecisionService: services.humanDecisionService,
      agentSettingsService: agentSettings,
      gitService,
      fileService,
      planStore: services.planStore,
      markdownPlanStore: services.markdownPlanStore,
      sprintRegistry: services.sprintRegistry,
      planOwnerAuth: services.planOwnerAuth,
      expectedProjectId: projectId,
      listResumableCheckpoints: services.listResumableCheckpoints
      ,projectStream
    })
  });
}
