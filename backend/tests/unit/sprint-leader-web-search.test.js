/** Verifies native Sprint Leader research stays role-bound, provider-compatible,
 * and unable to replace immutable project evidence or approval authority. */
import assert from "node:assert/strict";
import test from "node:test";
import { sprintLeaderWebSearchOptions } from "../../src/tools/roles/sprint-leader-web-search.js";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker/blocker-recovery-agent.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

test("native search honors SL role, provider support and Responses opt-out", () => {
  for (const provider of ["claude", "anthropic", "codex", "openai"]) {
    const profile = { role: "sprint_leader", provider };
    assert.notDeepEqual(sprintLeaderWebSearchOptions(profile), {});
    assert.deepEqual(sprintLeaderWebSearchOptions(profile, { builtinWebSearchAvailable: false }), {});
    assert.deepEqual(sprintLeaderWebSearchOptions(profile, { builtinWebSearchAvailable: () => false }), {});
    for (const role of ["coder", "reviewer", "architecture_manager", "system_engineer"]) {
      assert.deepEqual(sprintLeaderWebSearchOptions({ ...profile, role }), {});
    }
  }
  for (const provider of ["ollama", "xai", "alibaba", "zhipu", "deepseek"]) {
    assert.deepEqual(sprintLeaderWebSearchOptions({ role: "sprint_leader", provider }), {});
  }
  assert.deepEqual(sprintLeaderWebSearchOptions({ role: "sprint_leader", provider: "openai", use_responses: false }), {});
});

test("OpenAI exposes hosted search to SL only with Responses support", async () => {
  let options;
  const gateway = createOpenAiSdkGateway({
    providerFactory: { createForAgent: async (profile) => ({ provider: {}, profile: { ...profile, reasoning: { effort: "none" } } }) },
    AgentClass: class { constructor(input) { options = input; } },
    runner: async () => ({ finalOutput: "OK" })
  });
  for (const use_responses of [true, false]) {
    const profile = { agent_id: "SL", agent_name: "SL", role: "sprint_leader", provider: "openai", use_responses };
    await gateway.execute({ agent: profile, prompt: "Find documentation", correlationId: "SL-SEARCH", options: { builtinWebSearch: true } });
    assert.equal(options.tools.length, use_responses ? 1 : 0);
    if (use_responses) assert.equal(options.tools[0].name, "web_search");
  }
});

test("Claude recovery SL receives native WebSearch alongside canonical Forge tools", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const profile = { agent_id: "SL", role: "sprint_leader", provider: "anthropic", enabled: true, status: "ready" };
    const worker = createBlockerRecoveryAgent({
      agentResolver: { resolveAvailable: () => profile },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { claudeSdkGateway: { execute: async ({ options, prompt }) => {
        assert.deepEqual(options.tools, ["WebSearch"]);
        assert.ok(options.allowedTools.includes("WebSearch"));
        assert.ok(options.allowedTools.includes("mcp__forge__read_file"));
        assert.equal(options.allowedTools.includes("Bash"), false);
        assert.match(prompt, /web results never establish project source hashes or approved contract authority/);
        return { text: JSON.stringify(fixture.resolution) };
      } } }
    });
    await worker({ id: "JOB", stage: "sprint_leader", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] }, { deadline: Date.now() + 5000 });
  } finally { await fixture.close(); }
});
