import { EventEmitter } from "node:events";
import { createRuntimeService } from "../src/application/runtime-service.js";
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
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createTestService } from "../src/application/test-service.js";
import { createSprintPlanUploadService } from "../src/application/sprint-plan-upload-service.js";
import { createSprintOrchestrationService } from "../src/application/sprint-orchestration-service.js";
import { createTicketCommandParser } from "../src/application/ticket-command-parser.js";
import { createProseTicketService } from "../src/application/prose-ticket-service.js";
import { createCodeSearch } from "../src/modules/index/code-search.js";
import { createFileGraph } from "../src/modules/index/file-graph.js";
import { createRelevantTreeSelector } from "../src/modules/index/relevant-tree.js";

export function createControlApiPlatform({ config, database, indexDb, fileService, agentGateway, logEvent } = {}) {
  const { projectId, cwd: projectRoot } = config;
  const codeSearch = createCodeSearch({ database: indexDb });
  const fileGraph = createFileGraph({ database: indexDb });
  const relevantTreeSelector = createRelevantTreeSelector({ search: codeSearch, fileGraph, maxFiles: 30, defaultDepth: 1 });
  const communications = createAgentCommunicationStore({ database, fileService });
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
  const testService = createTestService({ verificationOrchestrator, fileService, projectRoot, publisher: eventPublisher, internalBus });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const memoryRetriever = createMemoryRetriever({ memory });
  const contextEngine = createContextEngine({ database: indexDb, projectRoot, projectId });
  const baseContext = createAgentContextService({ memoryRetriever, taskSummaries: summaries, taskStore });
  const maxFacts = Number(process.env.NODE_AGENT_MAX_FACTS ?? 200);
  const contextService = createFilesystemAwareContextService({ baseContextService: baseContext, contextEngine, budgetManager: createContextBudgetManager(), maxFacts, debug: (detail) => process.env.NODE_DEBUG_CONTEXT && console.debug(detail) });
  const agentRuntime = createAgentRuntime({ contextService, budgetManager: createContextBudgetManager(), planningEngine: createPlanningEngine(), publisher: eventPublisher, summaries, memory, maxFacts });
  const runtimeService = createRuntimeService({ sessionStore: createAgentSessionStore({ database }), eventStore, memoryRetriever, taskStore, agentRuntime, publisher: eventPublisher });
  const sprintOrchestration = createSprintOrchestrationService({ runtimeService, sprintPlans, sprintPlanStore: roadmaps, ticketProvenanceTracker: provenance, agentGateway, publisher: eventPublisher });
  const ticketCommandParser = createTicketCommandParser({ roadmapStore: roadmaps });
  const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
  const sprintPlanUpload = createSprintPlanUploadService({ roadmaps, projectRoot, isRunning: (sprintId) => sprintOrchestration.isRunning(sprintId) });
  return { projectId, codeSearch, fileGraph, relevantTreeSelector, communications, bus, decisions, roadmaps, knowledge, sprintPlans, provenance, eventStore, subscriptions, internalBus, eventPublisher, taskStore, ticketStatusStore, verificationOrchestrator, testService, contextEngine, runtimeService, sprintOrchestration, ticketCommandParser, proseTicketService, sprintPlanUpload };
}

function createTicketStatusLogger({ internalBus, logEvent }) {
  return (event) => {
    internalBus.emit(event.type, event);
    if (event.type !== "ticket.status_change" || !(event.to === "failed" || event.to === "needs_human_review" || event.details?.error)) return;
    logEvent({ timestamp: event.timestamp ?? new Date().toISOString(), event_name: "ticket.status_error", level: "error", status: "failed", message: event.details?.error ?? `Ticket status changed to ${event.to}.`, task_id: event.ticket_id, ticket_id: event.ticket_id, source: "ticket-status-store", error_code: event.details?.error_code ?? (event.to === "needs_human_review" ? "NEEDS_HUMAN_REVIEW" : "TICKET_FAILED"), payload: { ...event } });
  };
}
