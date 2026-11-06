// Business purpose: ensures generated AM-SE conversation IDs can reach the SDK without weakening filesystem ID safety.
// Technical description: exercises both provider gateways with a plan-scoped conversation and verifies the original subagent length limit remains enforced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { safeConversationId, safeSubagentId } from "../../src/modules/agent/runtime-instance.js";

const conversationId = "CONV-SE-PLAN-PROJECT-NODEFORGE-92677545-8fa2-44ef-b579-8997fa3045a5";

test("generated AM-SE conversation ID is safe but longer than a subagent ID", () => {
  assert.equal(safeConversationId(conversationId), conversationId);
  assert.throws(() => safeSubagentId(conversationId), { code: "SUBAGENT_ID_INVALID" });
  assert.throws(() => safeConversationId("../other"), { code: "CONVERSATION_ID_INVALID" });
  assert.throws(() => safeConversationId("a".repeat(193)), { code: "CONVERSATION_ID_INVALID" });
});

test("Claude SDK accepts the plan-scoped SE conversation before calling the provider", async () => {
  let calls = 0;
  const gateway = createClaudeSdkGateway({
    configuration: { getById: () => ({ agent_id: "se-test", agent_name: "SE", role: "system_engineer", enabled: true, status: "ready", credential_ref: "runtime:test", gateway_url: "https://gateway.example.test/anthropic", model: "test-model" }) },
    credentialResolver: () => "test-credential",
    terminalOutput: { write() {} },
    queryFn: () => { calls++; return (async function* () { yield { type: "assistant", message: { content: [{ type: "text", text: "Ready" }] } }; yield { type: "result", subtype: "success" }; })(); }
  });
  await gateway.execute({ agentId: "se-test", prompt: "Inspect", correlationId: "TEST-HANDOFF", conversationId });
  assert.equal(calls, 1);
});
