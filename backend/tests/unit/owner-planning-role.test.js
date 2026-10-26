// Verifies owner planning commands use the configured Architecture role, not the selected conversation agent.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

for (const text of ["/plan docs/scope.md", "/plan workflows/summary.md"]) {
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
    assert.equal(calls[0].payload.planning_input_only, true);
    assert.equal(calls[0].payload.response_content_type, "text/markdown");
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
  const result = await service.submit({ message_id: "MSG-A", project_id: "PROJECT-A", conversation_id: "CONV-A", correlation_id: "CORR-A", agent_id: "LEADER-CUSTOM", timestamp: "2026-10-09T00:00:00Z", payload: { text: "/plan docs/scope.md" } });
  assert.equal(result.message_type, "owner.command.error");
  assert.equal(launched, false);
});

// Keeps machine-readable planning replies free of the SDK's Markdown instruction
// while preserving the legacy file-based planning format and configured AM role.
test("explicit JSON planning format reaches the Architecture SDK for every planning stage", async () => {
  const calls = [];
  const service = createOwnerChatService({
    bus: { send: () => {}, sendFast: () => {} },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "ARCHITECTURE-CUSTOM" }) },
    commandService: { isCommand: () => true, execute: async ({ requestArchitecture }) => {
      for (const stage of ["discovery", "generation", "update"]) {
        await requestArchitecture(`Return JSON for ${stage}`, "CONV-A", { responseContentType: "text/plain" });
      }
      return { status: "created" };
    } },
    agentStream: async function* (input) { calls.push(input); yield { text: "{}" }; }
  });
  const result = await service.submit({ message_id: "MSG-A", project_id: "PROJECT-A", conversation_id: "CONV-A", correlation_id: "CORR-A", agent_id: "LEADER-CUSTOM", timestamp: "2026-10-26T00:00:00Z", payload: { text: "/plan docs/scope.md" } });
  assert.equal(result.message_type, "owner.command.result");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.payload.response_content_type, "text/plain");
    assert.equal(call.agentId, "ARCHITECTURE-CUSTOM");
    assert.equal(call.payload.planning_input_only, true);
  }
});
