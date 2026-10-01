// Verifies UI conversation messages use the persisted agent profile for provider routing.
import assert from "node:assert/strict";
import test from "node:test";

import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";

// Binds each message to the conversation's agent even if the request supplies another ID.
test("conversation messages dispatch to the persisted agent profile", async () => {
  const submitted = [];
  const routes = createForgeV1ConversationRoutes({
    conversationCrudService: { get: () => ({ id: "CONV-1", project_id: "PROJECT-1", agent_id: "a1111111-1111-4111-8111-111111111111", status: "active" }) },
    ownerChatService: { submit(input) { submitted.push(input); return { accepted: true }; } }
  });
  const result = await routes.routeConversation({ method: "POST", parts: ["conversations", "CONV-1", "messages"], url: new URL("http://localhost/forge/v1/conversations/CONV-1/messages"), projectId: "PROJECT-1", body: { agent_id: "spoofed", payload: { text: "hello" } } });
  assert.equal(result.status, 202);
  assert.equal(submitted[0].agent_id, "a1111111-1111-4111-8111-111111111111");
  assert.equal(submitted[0].conversation_id, "CONV-1");
  await assert.rejects(routes.routeConversation({ method: "POST", parts: ["conversations", "CONV-1", "messages"], url: new URL("http://localhost/forge/v1/conversations/CONV-1/messages"), projectId: "PROJECT-2", body: { payload: { text: "hello" } } }), /different project/);
  assert.equal(submitted.length, 1);
});
