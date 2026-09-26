import { EventEmitter } from "node:events";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { createPersistentEventStore } from "../src/modules/events/persistent-event-store.js";
import { createMemoryRetriever } from "../src/modules/history/memory-retriever.js";
import { createAgentCommunicationBus } from "../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../src/modules/governance/architecture-knowledge-model.js";
import { createRoadmapStore } from "../src/modules/governance/roadmap-store.js";
import { createSprintPlanProjection } from "../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../src/modules/governance/ticket-provenance-tracker.js";
import { createContextEngine } from "../src/modules/context/context-engine.js";
import { createTaskStore } from "../src/modules/projects/task-store.js";
import { createTicketStatusStore } from "../src/modules/projects/ticket-status-store.js";
import { createSubscriptionRegistry } from "../src/modules/events/subscription-registry.js";
import { createEventPublisher } from "../src/modules/events/event-publisher.js";
import { createHistoryStore } from "../src/modules/history/history-store.js";
import { createTaskSummaryStore } from "../src/modules/history/task-summary-store.js";
import { createProjectMemoryStore } from "../src/modules/history/project-memory-store.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createTestService } from "../src/application/test-service.js";
import { createSprintPlanUploadService } from "../src/application/sprint-plan-upload-service.js";
import { createSprintOrchestrationService } from "../src/application/sprint-orchestration-service.js";
import { createProseTicketService } from "../src/application/prose-ticket-service.js";
import { createRetrievalDependencies } from "../src/modules/index/retrieval-dependencies.js";
import { createRelevantTreeSelector } from "../src/modules/index/relevant-tree.js";
import { createIndexFreshnessChecker } from "../src/modules/index/index-freshness.js";
import { createConversationCrudService } from "../src/application/conversation-crud-service.js";
import { createTicketCandidateResolver } from "../src/application/ticket-candidate-resolver.js";
import { createTicketSprintLeader } from "../src/application/ticket-sprint-leader.js";
import { createSprintPlanLeader } from "../src/application/sprint-plan-leader.js";
import { createTicketFileStore } from "../src/application/ticket-file-store.js";

export function createControlApiPlatform({ config, database, indexDb, fileService, agentGateway, claudeSdkGateway, codexSdkGateway, agentRoleResolver, logEvent } = {}) {
  const { projectId, cwd: projectRoot } = config;
  const { search: codeSearch, fileGraph, embeddingStore, embeddingProvider } = createRetrievalDependencies({ database: indexDb });
  // Freshness checker compares indexed sha with live disk reads so candidates
  // served to agents are flagged stale instead of silently outdated. Best
  // effort: without fileService the selector falls back to plain select().
  const freshnessChecker = fileService?.readForIndex ? createIndexFreshnessChecker({ database: indexDb, fileService }) : null;
  const relevantTreeSelector = createRelevantTreeSelector({ search: codeSearch, fileGraph, embeddingStore, embeddingProvider, freshnessChecker, maxFiles: 30, defaultDepth: 1 });
  const ticketCandidateResolver = createTicketCandidateResolver({ relevantTreeSelector });
  // Sprint leader drafts through the configured SDK with built-in search; no Forge MCP tools.
  const sprintPlanSdkGateway = createRoleSdkGateway({ claudeSdkGateway, codexSdkGateway, agentRoleResolver });
  const ticketSprintLeader = sprintPlanSdkGateway ? createTicketSprintLeader({ sdkGateway: sprintPlanSdkGateway, projectRoot, logger: createTicketSprintLeaderLogger(logEvent) }) : undefined;
  const sprintPlanLeader = sprintPlanSdkGateway ? createSprintPlanLeader({ sdkGateway: sprintPlanSdkGateway, projectRoot }) : undefined;
  const communications = createAgentCommunicationStore({ database, fileService });
  const conversations = createConversationCrudService({ database });
  const bus = createAgentCommunicationBus({ store: communications });
  const decisions = createArchitectureDecisionStore({ database });
  const roadmaps = createRoadmapStore({ database });
  const knowledge = createArchitectureKnowledgeModel({ decisions });
  const sprintPlans = createSprintPlanProjection({ roadmaps });
  const provenance = createTicketProvenanceTracker({ roadmaps, decisions });
  const eventStore = createPersistentEventStore({ database });
  const subscriptions = createSubscriptionRegistry();
  const internalBus = new EventEmitter();
  const eventPublisher = createEventPublisher({ store: eventStore, subscriptions });
  const taskStore = createTaskStore({ database, projectId });
  const ticketStatusStore = createTicketStatusStore({ database, projectId, publisher: eventPublisher, onEvent: createTicketStatusLogger({ internalBus, logEvent }) });
  const verificationOrchestrator = createVerificationOrchestrator({ projectRoot, projectId });
  const testService = createTestService({ verificationOrchestrator, fileService, projectRoot, publisher: eventPublisher, internalBus, projectLogger: createTestJobLogger({ logEvent }) });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const memoryRetriever = createMemoryRetriever({ memory });
  const contextEngine = createContextEngine({ database: indexDb, projectRoot, projectId });
  const sprintOrchestration = createSprintOrchestrationService({ sprintPlans, sprintPlanStore: roadmaps, ticketProvenanceTracker: provenance, agentGateway, publisher: eventPublisher, candidateResolver: ticketCandidateResolver, sprintPlanLeader });
  const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
  const ticketFileStore = createTicketFileStore({ database, fileService });
  const sprintPlanUpload = createSprintPlanUploadService({ roadmaps, publisher: eventPublisher, projectRoot, isRunning: (sprintId) => sprintOrchestration.isRunning(sprintId) });
  return { projectId, indexDb, codeSearch, fileGraph, relevantTreeSelector, freshnessChecker, ticketCandidateResolver, ticketSprintLeader, memoryRetriever, communications, conversations, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, verificationOrchestrator, testService, contextEngine, sprintOrchestration, proseTicketService, ticketFileStore, sprintPlanUpload, taskSummaries: summaries, projectMemory: memory };
}

// Selects the SDK gateway for sprint leader drafting without touching gateway internals.
function createRoleSdkGateway({ claudeSdkGateway, codexSdkGateway, agentRoleResolver }) {
  if (!claudeSdkGateway && !codexSdkGateway) return undefined;
  return {
    async execute(request) {
      const profile = agentRoleResolver?.resolveProfile?.("sprint_leader");
      const gateway = selectSdkGateway(request?.agentId, { claudeSdkGateway, codexSdkGateway, agentRoleResolver });
      const provider = profile?.provider ?? (gateway === codexSdkGateway ? "codex" : "claude");
      try {
        const result = await gateway.execute(request);
        return {
          ...result,
          _gateway_diagnostics: {
            provider,
            model: profile?.model ?? null
          }
        };
      } catch (error) {
        error.gatewayDiagnostics = { provider, model: profile?.model ?? null };
        throw error;
      }
    }
  };
}

// Chooses the sprint leader provider gateway from the resolved sprint leader profile.
function selectSdkGateway(agentId, { claudeSdkGateway, codexSdkGateway, agentRoleResolver }) {
  const profile = agentRoleResolver?.resolveProfile?.("sprint_leader");
  if (profile?.agent_id === agentId && profile.provider === "codex" && codexSdkGateway) return codexSdkGateway;
  if (claudeSdkGateway) return claudeSdkGateway;
  if (codexSdkGateway) return codexSdkGateway;
  throw new Error("Sprint leader SDK gateway is unavailable.");
}
function createTicketStatusLogger({ internalBus, logEvent }) {
  // Forwards ticket status events and records failures for operators.
  return (event) => {
    internalBus.emit(event.type, event);
    if (event.type !== "ticket.status_change" || !(event.to === "failed" || event.to === "needs_human_review" || event.details?.error)) return;
    logEvent({ timestamp: event.timestamp ?? new Date().toISOString(), event_name: "ticket.status_error", level: "error", status: "failed", message: event.details?.error ?? `Ticket status changed to ${event.to}.`, task_id: event.ticket_id, ticket_id: event.ticket_id, source: "ticket-status-store", error_code: event.details?.error_code ?? (event.to === "needs_human_review" ? "NEEDS_HUMAN_REVIEW" : "TICKET_FAILED"), payload: { ...event } });
  };
}

function createTicketSprintLeaderLogger(logEvent) {
  return {
    error(eventName, details = {}) {
      logEvent?.({
        timestamp: new Date().toISOString(),
        event_name: eventName,
        level: "error",
        status: "failed",
        message: eventName,
        task_id: details.task_id ?? details.ticket_id ?? "PROJECT-NODEFORGE",
        ticket_id: details.ticket_id,
        correlation_id: details.correlation_id,
        source: "ticket-sprint-leader",
        payload: details
      });
    }
  };
}

function createTestJobLogger({ logEvent, output }) {
  const logger = createRuntimeLogger({ logEvent, ...(output ? { output } : {}) });
  return (entry) => logger.emit(entry);
}
