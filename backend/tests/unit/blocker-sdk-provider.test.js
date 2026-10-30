// Exercises recovery through distinct provider adapters so profile changes cannot silently launch another SDK.
// The worker retains read-only Forge discovery, preserves cancellation and reports the selected transport in its audit.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker/blocker-recovery-agent.js";

// Covers both coordinating roles and read-only Coder preparation with independently identifiable SDK adapters.
for (const role of ["sprint_leader", "architecture_manager", "coder"]) {
  for (const [provider, expected] of [["codex", "codexSdkGateway"], ["claude", "claudeSdkGateway"],
    ["anthropic", "claudeSdkGateway"], ["openai", "openaiSdkGateway"], ["ollama", "ollamaSdkGateway"],
    ["xai", "openaiSdkGateway"], ["alibaba", "openaiSdkGateway"], ["zhipu", "openaiSdkGateway"], ["deepseek", "openaiSdkGateway"]]) {
    test(`${role} profile ${provider} uses ${expected} without invoking another SDK`, async () => {
      const fixture = await blockerRecoveryFixture();
      const logs = [];
      const calls = [];
      const profile = { agent_id: "AGENT", role, provider, model: "profile-model", enabled: true, status: "ready" };
      try {
        const gateways = Object.fromEntries(["codexSdkGateway", "claudeSdkGateway", "openaiSdkGateway", "ollamaSdkGateway"].map((name) => [name, {
          execute: async (input) => {
            calls.push(name);
            assert.equal(name, expected);
            assert.equal(input.agent, profile);
            assert.equal(input.agentId, profile.agent_id);
            assert.equal(input.abortSignal.aborted, false);
            if (["claude", "anthropic"].includes(provider)) {
              assert.deepEqual(input.options.tools, []);
              assert(input.options.allowedTools.every((tool) => tool.startsWith("mcp__forge__")));
            } else {
              assert.equal(input.options.forgeTools.registry.commit_changes, undefined);
              assert.equal(input.options.forgeTools.registry.write_diff, undefined);
              const source = await input.options.forgeTools.registry.read_file.execute({ path: fixture.evidence.path });
              assert.equal(source.sha256, `sha256:${fixture.evidence.sha256}`);
              if (provider === "codex") {
                assert.equal(input.options.sandboxMode, "read-only");
                assert.deepEqual(input.options.configOverrides, ["features.shell_tool=false", "features.unified_exec=false"]);
              }
            }
            return { text: JSON.stringify(fixture.resolution) };
          }
        }]));
        const worker = createBlockerRecoveryAgent({ gateways, projectLogger: (entry) => logs.push(entry),
          agentResolver: { resolveAvailable: () => profile },
          agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
          resolveTicketWorkspace: async () => fixture.base.workspace });
        const result = await worker({ id: "JOB", stage: role, request: { task_id: "TASK", ticket: fixture.ticket }, history: [] },
          { deadline: Date.now() + 5000 });
        assert.equal(result.action, "resolved");
        assert.deepEqual(calls, [expected]);
        const started = logs.find((entry) => entry.event_name === "supervisor.blocker_triage_started");
        assert.equal(started.payload.sdk_gateway, expected);
        assert.equal(started.payload.provider, provider);
        assert.equal(started.payload.model, profile.model);
      } finally { await fixture.close(); }
    });
  }
}

// Missing native adapters and unsupported profiles must park without occupying an agent or falling back to OpenAI.
for (const provider of ["codex", "claude", "ollama", "custom", "unknown"]) {
  test(`${provider} with no matching SDK refuses fallback before claiming the agent`, async () => {
    const worker = createBlockerRecoveryAgent({
      agentResolver: { resolveAvailable: () => ({ agent_id: "SL", role: "sprint_leader", provider, enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => assert.fail("Unavailable SDK must not claim an agent") },
      gateways: { openaiSdkGateway: { execute: async () => assert.fail("Do not substitute another provider") } }
    });
    await assert.rejects(worker({ stage: "sprint_leader" }, { deadline: Date.now() + 5000 }),
      (error) => error.message.includes(`provider ${provider}`));
  });
}
