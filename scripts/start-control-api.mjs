import process from "node:process";
import { join } from "node:path";

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
  const gatewayUrl = codexBaseUrl.endsWith("/responses") ? codexBaseUrl : `${codexBaseUrl}/responses`;
  if (!current) profiles.create({ agent_id: "architecture-manager", agent_name: "Architecture Manager", gateway_url: gatewayUrl, credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "configured", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  else if (current.gateway_url.includes("gateway.example.test") || current.credential_ref.startsWith("runtime:")) profiles.update({ ...current, gateway_url: gatewayUrl, credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "configured", updated_at: new Date().toISOString() });
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
const runtimeService = createRuntimeService({
  sessionStore: createAgentSessionStore({ database }),
  eventStore,
  memoryRetriever: createMemoryRetriever({ memory: { get: () => undefined } })
});
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus, agentStream: ({ agentId, payload, correlationId }) => agentGateway.stream({ agentId, payload, correlationId }) }),
  conversationStream: createConversationStream({ bus, communicationStore: communications }),
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
  process.once(signal, () => server.close(() => database.close().finally(() => process.exit(0))));
}
