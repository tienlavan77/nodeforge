// Verifies chat approval carries verified owner identity into the plan command.
import assert from "node:assert/strict";
import test from "node:test";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";

// Rejects unauthenticated chat approval before creating a conversation message.
test("/approve route requires owner token and never trusts a client actor role", async () => {
  const calls = [];
  const routes = createForgeV1ConversationRoutes({
    conversationCrudService: { get: () => ({ project_id: "PROJECT-A", status: "active", agent_id: "ARCHITECT" }) },
    ownerChatService: { submit: async (body) => { calls.push(body); return body; } },
    planOwnerAuth: createPlanOwnerAuth({ token: "test-secret", ownerId: "OWNER-A" })
  });
  const request = { method: "POST", parts: ["conversations", "CONV-A", "messages"], url: new URL("http://localhost"), projectId: "PROJECT-A", body: { actor_role: "project_owner", payload: { text: "/approve PLAN-A", approval_revision: 1, approval_sha256: "a".repeat(64) } } };
  await assert.rejects(routes.routeConversation({ ...request, headers: {} }), { code: "PLAN_OWNER_UNAUTHORIZED" });
  assert.equal(calls.length, 0);
  await routes.routeConversation({ ...request, headers: { authorization: "Bearer test-secret" } });
  assert.equal(calls[0].approved_owner_id, "OWNER-A");
  assert.equal(calls[0].agent_id, "ARCHITECT");
});
