import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createArchitectureManagerAdapter } from "../../src/modules/governance/architecture-manager-adapter.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";

test("accepts Owner chat over HTTP, persists it before Architecture Manager dispatch, and audits correlation", async () => {
  const communication = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communication });
  const decisions = createArchitectureDecisionStore();
  const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps: createRoadmapStore(), bus, nodeId: "NODE-136" });
  createArchitectureManagerAdapter({ manager, bus, nodeId: "NODE-136" });
  let persistedBeforeDispatch = false;
  bus.subscribe("architecture-manager", (message) => { persistedBeforeDispatch = communication.getById(message.id) !== undefined; });
  const chat = createOwnerChatService({ bus });
  const api = createHttpApi({ runtimeService: runtimeStub(), ownerChatService: chat });
  const body = { message_id: "MSG-136", correlation_id: "CORR-136", timestamp: "2026-08-20T19:00:00Z", payload: { text: "Use Node as the only governance source of truth." } };

  const [status, accepted] = await request(api, "POST", "/projects/PROJECT-136/conversations/CONV-136/messages", body);

  assert.equal(status, 202);
  assert.equal(accepted.id, "MSG-136");
  assert.equal(accepted.conversation_id, "CONV-136");
  assert.equal(accepted.correlation_id, "CORR-136");
  assert.equal(accepted.sender.role, "project_owner");
  assert.equal(accepted.recipient.role, "architecture_manager");
  assert.equal(persistedBeforeDispatch, true);
  assert.equal(decisions.getById("DECISION-MSG-136").decision, body.payload.text);
  assert.deepEqual(communication.getByCorrelationId("CORR-136").map(({ message_type }) => message_type), ["owner.message", "architecture.message.received"]);
  assert.equal(communication.getById("MSG-136").conversation_id, "CONV-136");
});

test("rejects invalid owner messages and makes duplicate message IDs idempotent", async () => {
  const bus = createAgentCommunicationBus({ store: createAgentCommunicationStore() });
  let deliveries = 0;
  bus.subscribe("architecture-manager", () => { deliveries += 1; });
  const api = createHttpApi({ runtimeService: runtimeStub(), ownerChatService: createOwnerChatService({ bus }) });
  const valid = { message_id: "MSG-136-DUP", correlation_id: "CORR-136-DUP", timestamp: "2026-08-20T19:00:00Z", payload: { text: "Keep the architecture simple." } };
  assert.deepEqual((await request(api, "POST", "/projects/PROJECT-136/conversations/CONV-136/messages", valid))[0], 202);
  const [, duplicate] = await request(api, "POST", "/projects/PROJECT-136/conversations/CONV-136/messages", valid);
  assert.equal(duplicate.duplicate, true);
  assert.equal(deliveries, 1);
  const [invalidStatus] = await request(api, "POST", "/projects/PROJECT-136/conversations/CONV-136/messages", { ...valid, message_id: "MSG-136-BAD", payload: { text: "" } });
  assert.equal(invalidStatus, 400);
});

function runtimeStub() {
  return { startTask: () => ({}), pauseSession: () => ({}), resumeSession: () => ({}), getSession: () => ({}), getProjectMemory: () => ({}) };
}

async function request(api, method, url, body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = method;
  request.url = url;
  const response = { status: 0, chunks: [], writeHead(status) { this.status = status; }, end(chunk) { this.chunks.push(chunk); } };
  await api.handler(request, response);
  return [response.status, JSON.parse(response.chunks.join(""))];
}
