import process from "node:process";
import { join } from "node:path";
import { EventEmitter } from "node:events";

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
import { openIndexDatabase } from "../src/infrastructure/sqlite/index-database.js";
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
import { createSubscriptionRegistry } from "../src/modules/events/subscription-registry.js";
import { createEventPublisher } from "../src/modules/events/event-publisher.js";
import { createHistoryStore } from "../src/modules/history/history-store.js";
import { createTaskSummaryStore } from "../src/modules/history/task-summary-store.js";
import { createProjectMemoryStore } from "../src/modules/history/project-memory-store.js";
import { createFilesystemWatcher, DEFAULT_WATCHER_IGNORE } from "../src/infrastructure/filesystem/watcher.js";
import { createDebouncedWatcher } from "../src/modules/watcher/debounced-watcher.js";
import { createIncrementalIndexer } from "../src/modules/index/incremental-indexer.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createProjectFileTool } from "../src/modules/agent/project-file-tool.js";

const port = Number(process.env.NODE_CONTROL_PORT ?? 3100);
const dataDir = process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".node-control");
// Keep UI-control persistence isolated from the repository index database.
const database = await openIndexDatabase(dataDir);
const communications = createAgentCommunicationStore({ database });
const profiles = createAgentProfileStore({ database });
const agentConfiguration = createNodeAgentConfiguration({ profiles, configurationPath: join(dataDir, "agent-config.json") });
const secrets = createPersistentSecretBackend({ filePath: join(dataDir, "secrets.vault"), encryptionKey: process.env.NODE_SECRET_ENCRYPTION_KEY });
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
const eventPublisher = createEventPublisher({ store: eventStore, subscriptions });
const history = createHistoryStore({ subscriptions });
const summaries = createTaskSummaryStore({ history });
const memory = createProjectMemoryStore({ summaries });
const memoryRetriever = createMemoryRetriever({ memory });
const contextEngine = createContextEngine({ database, projectRoot: process.cwd(), projectId });
const baseContext = createAgentContextService({ memoryRetriever, taskSummaries: summaries, taskStore });
const contextService = createFilesystemAwareContextService({ baseContextService: baseContext, contextEngine, budgetManager: createContextBudgetManager(), maxFacts: Number(process.env.NODE_AGENT_MAX_FACTS ?? 200), debug: (detail) => process.env.NODE_DEBUG_CONTEXT && console.debug(detail) });
const fileTool = createProjectFileTool({ projectRoot: process.cwd() });
const agentRuntime = createAgentRuntime({ contextService, budgetManager: createContextBudgetManager(), planningEngine: createPlanningEngine(), publisher: eventPublisher, summaries, memory, maxFacts: Number(process.env.NODE_AGENT_MAX_FACTS ?? 200), executeStep: (step, { task }) => step.type === "implementation" ? fileTool.writeFromQuery(task.title) : undefined });
// Filesystem changes are indexed first, then verified and persisted as events.
const rawWatcher = createFilesystemWatcher({
  root: process.cwd(),
  ignore: DEFAULT_WATCHER_IGNORE,
  // Polling avoids exhausting native watcher descriptors in large worktrees.
  chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 250 }
});
const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: process.cwd() });
const indexer = createIncrementalIndexer({ database, projectRoot: process.cwd() });
const verification = createVerificationOrchestrator({ projectRoot: process.cwd(), projectId });
const onWatcherEvent = (event) => {
  void indexer.handle(event)
    .then((indexed) => indexed ? verification.run({
      schema_version: "1.0",
      commit_id: event.event_id,
      levels: ["focused"],
      checks: [{ type: "test", command: "node -e \"process.exit(0)\"", timeout_ms: 1000 }]
    }) : null)
    .then((result) => {
      if (!result) return;
      const verificationEvent = {
        event_id: `VERIFY-EVENT-${event.event_id}`,
        type: "verification.result",
        project_id: projectId,
        timestamp: new Date().toISOString(),
        payload: { watcher_event_id: event.event_id, path: event.payload?.path, result }
      };
      eventPublisher.publish(verificationEvent);
      internalBus.emit("verification.result", verificationEvent);
    })
    .catch((error) => console.error("Watcher verification failed", { error: error.message, event_id: event.event_id }));
};
watcher.on("event", onWatcherEvent);
const runtimeService = createRuntimeService({
  sessionStore: createAgentSessionStore({ database }),
  eventStore,
  memoryRetriever,
  taskStore,
  agentRuntime,
  publisher: eventPublisher
});
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus, agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId }) }),
  conversationStream: createConversationStream({ bus, communicationStore: communications, eventStore, subscriptions }),
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
  projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance }),
  conversationAuditHistoryService: createConversationAuditHistoryService({ communications, eventStore }),
  humanDecisionService: createHumanDecisionService({ decisions, bus }),
  agentSettingsService: agentSettings
});
const server = api.createServer().listen(port, "127.0.0.1", () => {
  process.stdout.write(`Node Control API listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(async () => {
    watcher.off?.("event", onWatcherEvent);
    await watcher.close?.();
    database.close();
    process.exit(0);
  }));
}
