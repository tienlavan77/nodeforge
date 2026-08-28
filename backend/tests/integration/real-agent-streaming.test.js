import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

test("streams ordered real Agent deltas realtime and persists only canonical completion for replay", async () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const observed = [];
  bus.subscribeAll((message) => observed.push(message));
  const chat = createOwnerChatService({ bus, agentStream: async function* () { yield { text: "one" }; yield { text: " two" }; yield { completed: true, response_id: "resp-149" }; } });
  chat.submit({ message_id: "MSG-149", project_id: "PROJECT-149", conversation_id: "CONV-149", correlation_id: "CORR-149", timestamp: "2026-08-20T00:00:00Z", payload: { text: "stream" } });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = store.getByConversationId("CONV-149");
  const deltas = observed.filter(({ message_type }) => message_type === "architecture.message.delta");
  assert.deepEqual(messages.map(({ message_type }) => message_type), ["owner.message", "architecture.working", "architecture.message.received"]);
  assert.deepEqual(deltas.map(({ payload }) => payload.text), ["one", " two"]);
  assert.equal(messages.at(-1).payload.text, "one two");
  assert(messages.every(({ correlation_id }) => correlation_id === "CORR-149"));
});

test("flushes buffered stream batches on interval and flushes final remainder at completion", async () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const observed = [];
  bus.subscribeAll((message) => observed.push(message));
  const chat = createOwnerChatService({ bus, streamBatchMs: 10, agentStream: async function* () { yield { text: "one" }; await new Promise((resolve) => setTimeout(resolve, 20)); yield { text: " two" }; } });
  chat.submit({ message_id: "MSG-149-BATCH", project_id: "PROJECT-149", conversation_id: "CONV-149-BATCH", correlation_id: "CORR-149-BATCH", timestamp: "2026-08-20T00:00:00Z", payload: { text: "stream" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const deltas = observed.filter(({ message_type }) => message_type === "architecture.message.delta");
  assert.deepEqual(deltas.map(({ payload }) => payload.text), ["one", " two"]);
  assert.equal(store.getByConversationId("CONV-149-BATCH").some(({ message_type }) => message_type === "architecture.message.delta"), false);
});

test("forwards the first delta immediately for short responses", async () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const observed = [];
  bus.subscribeAll((message) => observed.push(message));
  const chat = createOwnerChatService({ bus, streamBatchMs: 3000, agentStream: async function* () { yield { text: "short" }; } });
  chat.submit({ message_id: "MSG-149-SHORT", project_id: "PROJECT-149", conversation_id: "CONV-149-SHORT", correlation_id: "CORR-149-SHORT", timestamp: "2026-08-20T00:00:00Z", payload: { text: "stream" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.find((item) => item.message_type === "architecture.message.delta").payload.text, "short");
  assert.equal(store.getByConversationId("CONV-149-SHORT").some((item) => item.message_type === "architecture.message.delta"), false);
});
