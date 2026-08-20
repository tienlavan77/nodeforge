import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

test("persists ordered real Agent stream deltas and completion for SSE replay", async () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const chat = createOwnerChatService({ bus, agentStream: async function* () { yield { text: "one" }; yield { text: " two" }; yield { completed: true, response_id: "resp-149" }; } });
  chat.submit({ message_id: "MSG-149", project_id: "PROJECT-149", conversation_id: "CONV-149", correlation_id: "CORR-149", timestamp: "2026-08-20T00:00:00Z", payload: { text: "stream" } });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = store.getByConversationId("CONV-149");
  assert.deepEqual(messages.map(({ message_type }) => message_type), ["owner.message", "architecture.working", "architecture.message.delta", "architecture.message.delta", "architecture.message.received"]);
  assert.deepEqual(messages.slice(2, 4).map(({ payload }) => payload.text), ["one", " two"]);
  assert.equal(messages.at(-1).payload.text, "one two");
  assert(messages.every(({ correlation_id }) => correlation_id === "CORR-149"));
});
