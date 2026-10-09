// Verifies owner planning commands use the configured Architecture role, not the selected conversation agent.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

for (const text of ["/summary", "/plan SUMMARY-A"]) {
  test(`${text} routes through the configured Architecture profile`, async () => {
    const calls = [];
    const service = createOwnerChatService({
      bus: { send: () => {}, sendFast: () => {} },
      agentRoleResolver: { resolveProfile: (role) => { assert.equal(role, "architecture_manager"); return { agent_id: "ARCHITECTURE-CUSTOM" }; } },
      commandService: { isCommand: () => true, execute: async ({ requestArchitecture }) => ({ text: await requestArchitecture("Approved planning prompt", "CONV-A") }) },
      agentStream: async function* (input) { calls.push(input); yield { text: "Architecture output" }; }
    });
    const result = await service.submit({ message_id: "MSG-A", project_id: "PROJECT-A", conversation_id: "CONV-A", correlation_id: "CORR-A", agent_id: "LEADER-CUSTOM", timestamp: "2026-10-09T00:00:00Z", payload: { text } });
    assert.equal(result.message_type, "owner.command.result");
    assert.equal(result.payload.text, "Architecture output");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, "ARCHITECTURE-CUSTOM");
    assert.equal(calls[0].conversationId, "CONV-A");
  });
}

test("missing configured Architecture profile does not fall back to the selected agent", async () => {
  let launched = false;
  const service = createOwnerChatService({
    bus: { send: () => {}, sendFast: () => {} },
    agentRoleResolver: { resolveProfile: () => null },
    commandService: { isCommand: () => true, execute: async ({ requestArchitecture }) => requestArchitecture("Prompt", "CONV-A") },
    agentStream: async function* () { launched = true; yield { text: "Must not launch" }; }
  });
  const result = await service.submit({ message_id: "MSG-A", project_id: "PROJECT-A", conversation_id: "CONV-A", correlation_id: "CORR-A", agent_id: "LEADER-CUSTOM", timestamp: "2026-10-09T00:00:00Z", payload: { text: "/summary" } });
  assert.equal(result.message_type, "owner.command.error");
  assert.equal(launched, false);
});
