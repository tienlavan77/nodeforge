// Verifies the Sprint Leader role uses the configured provider SDK and exact agent profile.
import assert from "node:assert/strict";
import test from "node:test";
import { createRoleSdkGateway } from "../../scripts/control-api-platform.mjs";

// Routes the same tool-bearing request to each supported provider without fallback.
test("Sprint Leader dispatches Claude, Anthropic, Codex, and OpenAI profiles to their SDKs", async () => {
  for (const provider of ["claude", "anthropic", "codex", "openai"]) {
    const calls = [];
    const profile = { agent_id: `SL-${provider}`, agent_name: "Leader", role: "sprint_leader", provider, model: "model" };
    const gateway = (name) => ({ execute: async (request) => { calls.push({ name, request }); return { text: "ready" }; } });
    const roleGateway = createRoleSdkGateway({ claudeSdkGateway: gateway("claude"), codexSdkGateway: gateway("codex"), openaiSdkGateway: gateway("openai"), agentRoleResolver: { resolveProfile: () => profile } });
    await roleGateway.execute({ agentId: profile.agent_id, prompt: "Plan", options: { forgeTools: { definitions: [{ name: "search_tree" }] } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, provider === "anthropic" ? "claude" : provider);
    assert.deepEqual(calls[0].request.options.forgeTools.definitions.map(({ name }) => name), ["search_tree"]);
    if (provider === "openai") assert.equal(calls[0].request.agent.agent_id, profile.agent_id);
    if (provider === "codex") await assert.rejects(calls[0].request.onEvent({ type: "item.started", item: { type: "command_execution" } }), { code: "TOOL_FORBIDDEN" });
    await assert.rejects(roleGateway.execute({ agentId: "OTHER", prompt: "Plan" }), /does not match/);
  }
});
