// Business purpose: prevents the handoff Resume button from sending an incomplete Owner message.
// Technical description: sends the browser client's generated request through the real conversation route and Owner message validator, while replacing agent execution with a harmless command callback.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerExecutionClient } from "../lib/owner-execution-client.js";
import { createForgeV1ConversationRoutes } from "../../../backend/src/transport/http/forge-v1-conversation-routes.js";
import { createOwnerChatService } from "../../../backend/src/application/owner-chat-service.js";

// Business purpose: verifies Owner-authenticated handoff resume reaches the command boundary with exact plan identity.
// Technical description: asserts required envelope fields, route-derived Owner identity, and absence of an agent execution in a safe, isolated fixture.
test("handoff Resume sends a valid authenticated Owner message envelope", async () => {
  const projectId = "PROJECT-TEST";
  const conversationId = "CONV-AM";
  const handoff = { handoff_id: "HANDOFF-PLAN-TEST-R1", plan_revision: 2, plan_sha256: "a".repeat(64), roles: { am: { conversation_id: conversationId } } };
  const submissions = [];
  const bus = { send: (message) => message };
  const ownerChatService = createOwnerChatService({ bus, commandService: {
    isCommand: (text) => text.startsWith("/resume-se-handoff "),
    execute: async (input) => { submissions.push(input); return { status: "paused", handoff_id: handoff.handoff_id }; }
  } });
  const route = createForgeV1ConversationRoutes({ ownerChatService, conversationCrudService: {
    get: () => ({ id: conversationId, project_id: projectId, status: "active", agent_id: "architecture-manager" }),
    ensure: () => {}
  }, planOwnerAuth: { verify: (headers) => headers.authorization === "Bearer owner-token" ? "OWNER-TEST" : null } });
  const client = createOwnerExecutionClient({
    forgeV1: (path) => path,
    requestJson: async (path, options) => (await route.routeConversation({ method: options.method, parts: path.split("/").filter(Boolean), projectId, url: new URL("http://localhost"), headers: options.headers, body: JSON.parse(options.body) })).body
  });
  const response = await client.resumeHandoff(projectId, handoff, "owner-token");
  assert.equal(response.message_type, "owner.command.result");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].approvedOwnerId, "OWNER-TEST");
  assert.equal(submissions[0].approvalRevision, 2);
  assert.equal(submissions[0].approvalSha256, handoff.plan_sha256);
  assert.equal(submissions[0].conversationId, conversationId);
});

// Business purpose: surfaces a backend handoff refusal instead of treating HTTP 202 as a successful resume.
// Technical description: exercises the same client, route and Owner message validator with a rejected command result.
test("handoff Resume displays command errors returned inside HTTP 202", async () => {
  const projectId = "PROJECT-TEST";
  const conversationId = "CONV-AM";
  const handoff = { handoff_id: "HANDOFF-PLAN-TEST-R1", plan_revision: 2, plan_sha256: "a".repeat(64), roles: { am: { conversation_id: conversationId } } };
  const ownerChatService = createOwnerChatService({ bus: { send: (message) => message }, commandService: {
    isCommand: () => true, execute: async () => { throw new Error("PLAN_APPROVAL_REQUIRED"); }
  } });
  const route = createForgeV1ConversationRoutes({ ownerChatService, conversationCrudService: {
    get: () => ({ id: conversationId, project_id: projectId, status: "active", agent_id: "architecture-manager" }), ensure: () => {}
  }, planOwnerAuth: { verify: () => "OWNER-TEST" } });
  const client = createOwnerExecutionClient({ forgeV1: (path) => path,
    requestJson: async (path, options) => (await route.routeConversation({ method: options.method, parts: path.split("/").filter(Boolean), projectId, url: new URL("http://localhost"), headers: options.headers, body: JSON.parse(options.body) })).body });
  await assert.rejects(client.resumeHandoff(projectId, handoff, "owner-token"), /PLAN_APPROVAL_REQUIRED/);
});
