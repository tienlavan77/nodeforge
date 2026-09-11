import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";

test("runs a hello prompt through an isolated OpenAI Agents SDK provider", async () => {
  let agentOptions;
  let runInput;
  let runOptions;
  const provider = { close: async () => {} };
  const gateway = createOpenAiSdkGateway({
    providerFactory: {
      async createForAgent(profile) {
        assert.equal(profile.agent_id, "builder");
        return { provider, profile: { ...profile, reasoning: { effort: "high" } } };
      }
    },
    AgentClass: class FakeAgent {
      constructor(options) { agentOptions = options; this.options = options; }
    },
    runner: async (agent, input, options) => {
      runInput = input;
      runOptions = options;
      assert.deepEqual(agent.options, agentOptions);
      return { finalOutput: "Hello from Builder." };
    }
  });
  const result = await gateway.execute({
    agent: { agent_id: "builder", agent_name: "Builder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: "secret", model: "gpt-5.6-sol" },
    correlationId: "CORR-HELLO",
    prompt: "Say hello to the NodeForge Supervisor."
  });
  assert.equal(runInput, "Say hello to the NodeForge Supervisor.");
  assert.equal(runOptions.modelProvider, provider);
  assert.equal(runOptions.maxTurns, 1);
  assert.equal(runOptions.tracingDisabled, true);
  assert.deepEqual(agentOptions.tools, []);
  assert.equal(agentOptions.model, "gpt-5.6-sol");
  assert.deepEqual(agentOptions.modelSettings, { reasoning: { effort: "high" } });
  assert.equal(result.text, "Hello from Builder.");
  assert.equal(result.correlation_id, "CORR-HELLO");
});

test("omits reasoning settings when effort is none for gateway compatibility", async () => {
  let agentOptions;
  const gateway = createOpenAiSdkGateway({
    providerFactory: { async createForAgent(profile) { return { provider: {}, profile: { ...profile, reasoning: { effort: "none" } } }; } },
    AgentClass: class FakeAgent { constructor(options) { agentOptions = options; } },
    runner: async () => ({ finalOutput: "ok" })
  });
  await gateway.execute({
    agent: { agent_id: "builder", agent_name: "Builder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: "secret", model: "gpt-4o-mini" },
    correlationId: "CORR-HELLO",
    prompt: "hello"
  });
  assert.equal(Object.hasOwn(agentOptions, "modelSettings"), false);
});
