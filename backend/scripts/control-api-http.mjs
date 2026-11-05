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
import { createPlanRequestState } from "../src/application/plan-request-state.js";
import { createWatcherCacheEvents } from "../src/modules/context/watcher-cache-events.js";
import { createMarkdownResponseFileService } from "../src/application/markdown-response-file-service.js";
import { createProjectDirectoryLifecycle } from "../src/application/project-directory-lifecycle.js";
import { createNotebookProjectAuth } from "../src/modules/governance/notebook-project-auth.js";

export function createControlApiHttp({ services = {}, resolveProjectServices, notebookPermissionPort, notebookAuth } = {}) {
  return createHttpApi(createControlApiHttpOptions({ services, resolveProjectServices, notebookPermissionPort, notebookAuth }));
}

// Lazily composes and reuses application services only for the resolved runtime identity.
function createProjectRouterResolver(resolveProjectServices) {
  const routers = new WeakMap();
  // Refuses unknown or mismatched service bundles instead of borrowing the default project's services.
  return async function resolveProjectRouter(projectId) {
    const selected = await resolveProjectServices(projectId);
    if (!selected || selected.projectId !== projectId) return undefined;
    if (!routers.has(selected)) routers.set(selected, createControlApiHttpOptions({ services: selected }).forgeV1Router);
    return routers.get(selected);
  };
}

// Composes conversation, plan, sprint, Git, and execution services for one selected project.
function createControlApiHttpOptions({ services = {}, resolveProjectServices, notebookPermissionPort, notebookAuth } = {}) {
  const { bus, communications, conversations, eventStore, indexDb, subscriptions, agentSettings, sprintPlanUpload, sprintOrchestration, sprintPlanLeader, dispatchSprint, dispatchTicket, reviewTicket, runToolLab, directCodeRequest, codeCache, internalBus, ticketCrudService, buildBuilderContext, protocolStorage, agentGateway, agentConfiguration, sdkGateways, conversationStateStore, fileService, planFileService, projectRoot, publishUnifiedStreamEvent, logEvent, projectId, gitService, ticketBlockerReconcileService } = services;
  const projectLifecycle = createProjectDirectoryLifecycle({ projectLifecycle: services.projectLifecycle, projectId, projectRoot });
  const composedNotebookAuth = notebookAuth ?? services.notebookAuth ?? createNotebookProjectAuth({
    planOwnerAuth: services.planOwnerAuth,
    canAccessProject: notebookPermissionPort ?? services.notebookPermissionPort ?? services.canAccessProject
  });
  const agentLoopLogger = createRuntimeLogger({ logEvent, source: "owner-chat-agent-loop" });
  const executionCheckpoint = createOwnerExecutionCheckpoint({ fileService, gitService, role: "system_engineer" });
  const architectureCheckpoint = createOwnerExecutionCheckpoint({ fileService, role: "architecture_manager" });
  const sdkStream = createOwnerSdkStream({ executionCheckpoint, architectureCheckpoint, agentConfiguration, sdkGateways, fallbackStream: (input) => agentGateway.stream(input), conversationStateStore, conversationMessages: communications, fileService, codeCache, codeSearch: services.codeSearch, gitService, testService: services.testService, projectRoot, projectLogger: agentLoopLogger.emit });
  const planHandoff = services.planStore && services.database ? createPlanHandoffService({ projectId, database: services.database, planStore: services.planStore, markdownPlanStore: services.markdownPlanStore, sprintPlanLeader, sprintOrchestration, sprintRegistry: services.sprintRegistry, agentRoleResolver: services.agentRoleResolver }) : null;
  const planRequests = projectId && fileService?.createLock && fileService?.atomicWrite ? createPlanRequestState({ projectId, fileService }) : null;
  const commandService = services.planStore && (planFileService || services.fileService) ? createOwnerChatCommandService({ projectId, planRequests, publishPlanEvent: (event) => projectStream.ingest(event), fileService: planFileService || services.fileService, communications, bus, conversationCrudService: conversations, agentRoleResolver: services.agentRoleResolver, planStore: services.planStore, markdownPlanStore: services.markdownPlanStore, gitService, executionCheckpoint, sprintRegistry: services.sprintRegistry, handoffApprovedPlan: ({ plan, conversationId }) => planHandoff.handoff({ plan, conversationId }) }) : null;
  const ownerChatService = createOwnerChatService({ bus, communications, agentRoleResolver: services.agentRoleResolver, projectLogger: logEvent, internalBus, buildAgentContext: buildBuilderContext, protocolStorage, conversationCrudService: conversations, commandService, debug: (detail) => agentLoopLogger.emit({ event_name: detail?.event ?? "agent.loop", level: detail?.event === "project-log.error" ? "error" : "debug", status: "info", message: detail?.event ?? "Agent loop debug event.", task_id: detail?.task_id, correlation_id: detail?.correlation_id, payload: detail }), agentStream: ({ agentId, payload, correlationId, conversationId }) => sdkStream({ agentId, payload, correlationId, conversationId, eventSink: publishUnifiedStreamEvent }), onAgentCompleted: sprintOrchestration.ingestAgentCompletion });
  const ownerExecutionControl = createOwnerExecutionControl({ checkpoint: executionCheckpoint, architectureCheckpoint, sdkStream, ownerChatService, communications, agentConfiguration });
  /**
   * Business purpose: wraps a project-scoped SSE stream so closing or removing the project immediately terminates all active SSE connections for that project without affecting other projects.
   * Technical description: intercepts stream.connect(), registers a disconnect callback with services.registerStreamCleanup when present, and unregisters on client disconnect.
   */
  function bindOwnedStream(baseStream) {
    if (!baseStream || typeof services.registerStreamCleanup !== "function") return baseStream;
    // Wraps a resolved connection handle so application disposal closes it and ends the HTTP response.
    const wrapConnection = (connection, input) => {
      const unregister = services.registerStreamCleanup(() => {
        connection?.close?.();
        if (input?.response && !input.response.writableEnded) input.response.end?.();
      });
      input?.response?.once?.("close", unregister);
      return Object.freeze({
        ...connection,
        // Closes the SSE connection and removes its disposal registration.
        close() {
          unregister();
          return connection?.close?.();
        }
      });
    };
    return Object.freeze({
      ...baseStream,
      // Registers the open SSE connection with the project application disposal lifecycle.
      connect(input) {
        const connection = baseStream.connect(input);
        if (typeof connection?.then === "function") {
          return connection.then((resolved) => wrapConnection(resolved, input));
        }
        return wrapConnection(connection, input);
      }
    });
  }
  const conversationStream = bindOwnedStream(createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions }));
  const markdownResponseFileService = projectId && projectRoot && typeof conversations?.get === "function" && typeof communications?.getById === "function" && typeof fileService?.atomicCreate === "function" && typeof fileService?.atomicWrite === "function"
    ? createMarkdownResponseFileService({ projectId, projectRoot, conversations, communications, fileService, logger: logEvent })
    : null;
  const projectStream = bindOwnedStream(createProjectStream({
    projectId,
    watcherSnapshot: createWatcherSnapshotService({ indexDb }),
    runtimeSnapshot: () => {
      const st = services.runtime?.status?.();
      return st?.progress ? { readiness: st.readiness, stage: st.progress.stage, status: st.progress.status, progress: st.progress } : undefined;
    },
    subscriptions,
    eventBus: internalBus,
    bus,
    agentActivitySnapshot: services.executionActivity?.snapshot
  }));
  const onWatcherEvent = createWatcherCacheEvents({ projectId, codeCache, logger: agentLoopLogger.emit });
  return {
    ownerChatService,
    conversationStream,
    projectStream,
    architectureWorkspaceService: services.architectureWorkspaceService,
    projectDashboardService: services.projectDashboardService,
    conversationAuditHistoryService: services.conversationAuditHistoryService,
    humanDecisionService: services.humanDecisionService,
    projectLifecycle,
    agentSettingsService: agentSettings,
    sprintPlanUploadService: sprintPlanUpload,
    sprintOrchestrationService: sprintOrchestration,
    dispatchSprint,
    dispatchTicket,
    reviewTicket,
    runToolLab,
    forgeV1Router: createForgeV1Router({
      assertAdmission: services.assertAdmission,
      conversationStream,
      resolveProjectRouter: resolveProjectServices ? createProjectRouterResolver(resolveProjectServices) : undefined,
      notebookAuth: composedNotebookAuth,
      resolveProjectServices,
      notebookStore: services.notebook,
      controlDb: services.controlDb ?? services.database,
      projectLifecycle,
      dispatchTicket,
      dispatchSprint,
      sprintOrchestrationService: sprintOrchestration,
      reviewTicket,
      ticketHumanReviewService: services.ticketHumanReviewService,
      ticketBlockerDecisionService: services.ticketBlockerDecisionService,
      ticketBlockerReconcileService,
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
      markdownResponseFileService,
      architectureWorkspaceService: services.architectureWorkspaceService,
      humanDecisionService: services.humanDecisionService,
      agentSettingsService: agentSettings,
      gitService,
      fileService,
      planStore: services.planStore,
      markdownPlanStore: services.markdownPlanStore,
      planRequests,
      sprintRegistry: services.sprintRegistry,
      planOwnerAuth: services.planOwnerAuth,
      handoffApprovedPlan: planHandoff ? (input) => planHandoff.handoff(input) : null,
      expectedProjectId: projectId,
      listResumableCheckpoints: services.listResumableCheckpoints,
      projectStream
    })
  };
}
