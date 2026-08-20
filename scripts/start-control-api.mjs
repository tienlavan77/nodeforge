import process from "node:process";
import { join } from "node:path";

import { createRuntimeService } from "../src/application/runtime-service.js";
import { createArchitectureWorkspaceService } from "../src/application/architecture-workspace-service.js";
import { createOwnerChatService } from "../src/application/owner-chat-service.js";
import { openIndexDatabase } from "../src/infrastructure/sqlite/index-database.js";
import { createAgentSessionStore } from "../src/modules/agent/session-store.js";
import { createPersistentEventStore } from "../src/modules/events/persistent-event-store.js";
import { createMemoryRetriever } from "../src/modules/history/memory-retriever.js";
import { createAgentCommunicationBus } from "../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../src/modules/governance/architecture-manager.js";
import { createArchitectureManagerAdapter } from "../src/modules/governance/architecture-manager-adapter.js";
import { createRoadmapStore } from "../src/modules/governance/roadmap-store.js";
import { createSprintPlanProjection } from "../src/modules/governance/sprint-plan-projection.js";
import { createHttpApi } from "../src/transport/http/server.js";
import { createConversationStream } from "../src/transport/sse/conversation-stream.js";

const port = Number(process.env.NODE_CONTROL_PORT ?? 3100);
// Keep UI-control persistence isolated from the repository index database.
const database = await openIndexDatabase(process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".node-control"));
const communications = createAgentCommunicationStore();
const bus = createAgentCommunicationBus({ store: communications });
const decisions = createArchitectureDecisionStore();
const roadmaps = createRoadmapStore();
const knowledge = createArchitectureKnowledgeModel({ decisions });
const manager = createArchitectureManager({
  decisions,
  knowledge,
  roadmaps,
  bus,
  nodeId: "NODE"
});
createArchitectureManagerAdapter({ manager, bus, nodeId: "NODE" });

const runtimeService = createRuntimeService({
  sessionStore: createAgentSessionStore({ database }),
  eventStore: createPersistentEventStore({ database }),
  memoryRetriever: createMemoryRetriever({ memory: { get: () => undefined } })
});
const api = createHttpApi({
  runtimeService,
  ownerChatService: createOwnerChatService({ bus }),
  conversationStream: createConversationStream({ bus, communicationStore: communications }),
  architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans: createSprintPlanProjection({ roadmaps }) })
});
const server = api.createServer().listen(port, "127.0.0.1", () => {
  process.stdout.write(`Node Control API listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => database.close().finally(() => process.exit(0))));
}
