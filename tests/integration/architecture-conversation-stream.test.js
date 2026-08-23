import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createArchitectureManagerAdapter } from "../../src/modules/governance/architecture-manager-adapter.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createConversationStream } from "../../src/transport/sse/conversation-stream.js";
import { createHttpApi } from "../../src/transport/http/server.js";

test("streams real Architecture Manager work only to its conversation in persisted order", () => {
  const { chat, communications, stream, decisions } = createFixture();
  const response = responseStub();
  const connection = stream.connect({ projectId: "PROJECT-137", conversationId: "CONV-ARCH", response });

  chat.submit(ownerMessage("MSG-137-1", "CONV-ARCH", "CORR-137-1"));
  chat.submit(ownerMessage("MSG-137-OTHER", "CONV-OTHER", "CORR-137-OTHER"));
  const events = parseEvents(response.chunks);

  assert.deepEqual(events.map(({ message_type }) => message_type), ["owner.message", "architecture.working", "architecture.message.received"]);
  assert.deepEqual(events.map(({ message_id }) => message_id), ["MSG-137-1", "MSG-ARCHITECTURE-WORKING-MSG-137-1", "MSG-ARCHITECTURE-MESSAGE-MSG-137-1"]);
  assert(events.every((event) => event.conversation_id === "CONV-ARCH" && event.correlation_id === "CORR-137-1"));
  assert(events.every((event) => event.agent_id));
  assert.equal(decisions.getById("DECISION-MSG-137-1").decision, "Create a governed plan.");
  assert.deepEqual(communications.getByConversationId("CONV-ARCH").map(({ id }) => id), events.map(({ message_id }) => message_id));
  assert.equal(connection.close(), true);
  assert.equal(connection.close(), false);
});

test("reconnect replays only missed persisted conversation messages without executing the Agent again", () => {
  const { chat, stream, decisions } = createFixture();
  const first = responseStub();
  const firstConnection = stream.connect({ projectId: "PROJECT-137", conversationId: "CONV-ARCH", response: first });
  chat.submit(ownerMessage("MSG-137-RECONNECT-1", "CONV-ARCH", "CORR-137-R1"));
  firstConnection.close();
  const lastId = parseEvents(first.chunks).at(-1).message_id;
  chat.submit(ownerMessage("MSG-137-RECONNECT-2", "CONV-ARCH", "CORR-137-R2"));

  const second = responseStub();
  const secondConnection = stream.connect({ projectId: "PROJECT-137", conversationId: "CONV-ARCH", response: second, afterMessageId: lastId });
  const replayed = parseEvents(second.chunks);

  assert.deepEqual(replayed.map(({ message_id }) => message_id), ["MSG-137-RECONNECT-2", "MSG-ARCHITECTURE-WORKING-MSG-137-RECONNECT-2", "MSG-ARCHITECTURE-MESSAGE-MSG-137-RECONNECT-2"]);
  assert.equal(decisions.getAll().length, 2);
  secondConnection.close();
});

test("exposes the persisted conversation stream through the Node HTTP SSE endpoint", async () => {
  const { chat, stream } = createFixture();
  chat.submit(ownerMessage("MSG-137-HTTP", "CONV-ARCH", "CORR-137-HTTP"));
  const api = createHttpApi({ runtimeService: runtimeStub(), conversationStream: stream });
  const request = Readable.from([]);
  request.method = "GET";
  request.url = "/projects/PROJECT-137/conversations/CONV-ARCH/stream";
  request.headers = {};
  const response = responseStub();

  await api.handler(request, response);

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(parseEvents(response.chunks).at(-1).message_type, "architecture.message.received");
  request.emit("close");
  assert.equal(response.ended, true);
});

test("limits initial replay while preserving the tail of a large conversation", () => {
  const bus = createAgentCommunicationBus();
  const messages = Array.from({ length: 150 }, (_, index) => ({
    id: `MSG-LARGE-${index}`,
    project_id: "PROJECT-137",
    conversation_id: "CONV-LARGE",
    correlation_id: null,
    message_type: "owner.message",
    timestamp: "2026-08-21T00:00:00Z",
    sequence: index,
    sender: { id: "OWNER", role: "owner" },
    recipient: { id: "NODE", role: "node" },
    payload: { text: String(index) }
  }));
  const stream = createConversationStream({ bus, communicationStore: { getByConversationId: () => messages } });
  const response = responseStub();
  const connection = stream.connect({ projectId: "PROJECT-137", conversationId: "CONV-LARGE", response, replayLimit: 25 });
  const replayed = parseEvents(response.chunks);
  assert.equal(replayed.length, 25);
  assert.equal(replayed[0].message_id, "MSG-LARGE-125");
  assert.equal(replayed.at(-1).message_id, "MSG-LARGE-149");
  connection.close();
});

test("replays from a valid cursor regardless of initial history size", () => {
  const bus = createAgentCommunicationBus();
  const messages = Array.from({ length: 150 }, (_, index) => ({
    id: `MSG-CURSOR-${index}`,
    project_id: "PROJECT-137",
    conversation_id: "CONV-CURSOR",
    correlation_id: null,
    message_type: "owner.message",
    timestamp: "2026-08-21T00:00:00Z",
    sequence: index,
    sender: { id: "OWNER", role: "owner" },
    recipient: { id: "NODE", role: "node" },
    payload: { text: String(index) }
  }));
  const stream = createConversationStream({ bus, communicationStore: { getByConversationId: () => messages } });
  const response = responseStub();
  const connection = stream.connect({ projectId: "PROJECT-137", conversationId: "CONV-CURSOR", response, afterMessageId: "MSG-CURSOR-140", replayLimit: 2 });
  const replayed = parseEvents(response.chunks);
  assert.deepEqual(replayed.map((event) => event.message_id), ["MSG-CURSOR-141", "MSG-CURSOR-142", "MSG-CURSOR-143", "MSG-CURSOR-144", "MSG-CURSOR-145", "MSG-CURSOR-146", "MSG-CURSOR-147", "MSG-CURSOR-148", "MSG-CURSOR-149"]);
  connection.close();
});

test("does not lose a live message emitted while the replay snapshot is loading", () => {
  const observers = [];
  const bus = {
    subscribeAll(handler) { observers.push(handler); },
    unsubscribeAll(handler) { observers.splice(observers.indexOf(handler), 1); },
    emit(message) { for (const observer of observers) observer(message); }
  };
  const liveMessage = {
    id: "MSG-LIVE-DURING-REPLAY",
    project_id: "PROJECT-137",
    conversation_id: "CONV-RACE",
    correlation_id: null,
    message_type: "node.message",
    timestamp: "2026-08-21T00:00:01Z",
    sender: { id: "NODE", role: "node" },
    recipient: { id: "OWNER", role: "owner" },
    payload: { text: "live" }
  };
  let store;
  store = { getByConversationId() {
    bus.emit(liveMessage);
    return [];
  } };
  const stream = createConversationStream({ bus, communicationStore: store });
  const response = responseStub();
  const connection = stream.connect({ projectId: "PROJECT-137", conversationId: "CONV-RACE", response });
  assert.deepEqual(parseEvents(response.chunks).map((event) => event.message_id), ["MSG-LIVE-DURING-REPLAY"]);
  connection.close();
});

function createFixture() {
  const communications = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communications });
  const decisions = createArchitectureDecisionStore();
  const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps: createRoadmapStore(), bus, nodeId: "NODE-137" });
  createArchitectureManagerAdapter({ manager, bus, nodeId: "NODE-137" });
  return { chat: createOwnerChatService({ bus }), communications, stream: createConversationStream({ bus, communicationStore: communications }), decisions };
}

function ownerMessage(message_id, conversation_id, correlation_id) {
  return { message_id, project_id: "PROJECT-137", conversation_id, correlation_id, timestamp: "2026-08-21T00:00:00Z", payload: { text: "Create a governed plan." } };
}

function responseStub() {
  return { chunks: [], status: 0, headers: {}, writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, write(chunk) { this.chunks.push(chunk); }, end() { this.ended = true; } };
}

function parseEvents(chunks) {
  return chunks.filter((chunk) => chunk.startsWith("id: ")).map((chunk) => JSON.parse(chunk.split("\ndata: ")[1].split("\n\n")[0]));
}

function runtimeStub() {
  return { startTask: () => ({}), pauseSession: () => ({}), resumeSession: () => ({}), getSession: () => ({}), getProjectMemory: () => ({}) };
}
