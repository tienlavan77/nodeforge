import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

test("routes the Owner message to a configured Agent Gateway and persists the real response", async () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const chat = createOwnerChatService({ bus, agentRequest: async ({ payload, correlationId }) => ({ correlation_id: correlationId, payload: { text: `Gateway response to: ${payload.text}`, response_id: "resp-test" } }) });
  chat.submit({ message_id: "MSG-148", project_id: "PROJECT-148", conversation_id: "CONV-148", correlation_id: "CORR-148", timestamp: "2026-08-20T00:00:00Z", payload: { text: "Create an architecture plan" } });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = store.getByConversationId("CONV-148");
  assert.deepEqual(messages.map(({ message_type }) => message_type), ["owner.message", "architecture.message.received"]);
  assert.equal(messages[1].payload.text, "Gateway response to: Create an architecture plan");
  assert.equal(messages[1].correlation_id, "CORR-148");
});
