import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { readFileDefinition, writeDiffDefinition, editDiffDefinition } from "../../src/tools/index.js";

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
  assert.equal(runOptions.maxTurns, null);
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

// Ensures conversations use each profile's provider instead of the SDK's default CLI credential.
test("binds the real Runner to the provider selected for each profile", async () => {
  const usedProfiles = [];
  const gateway = createOpenAiSdkGateway({
    providerFactory: {
      async createForAgent(profile) {
        const id = profile.agent_id;
        return {
          profile: { ...profile, reasoning: { effort: "none" } },
          provider: {
            getModel() {
              usedProfiles.push(id);
              return {
                async getResponse() {
                  return {
                    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: id }] }],
                    usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    responseId: id
                  };
                }
              };
            }
          }
        };
      }
    }
  });
  for (const id of ["profile-one", "profile-two"]) {
    const result = await gateway.execute({
      agent: { agent_id: id, agent_name: id, role: "architecture_manager", gateway_url: "https://gateway.test/v1", credential_ref: id, model: "gpt-4o-mini" },
      correlationId: id,
      prompt: "hello"
    });
    assert.equal(result.text, id);
  }
  assert.deepEqual(usedProfiles, ["profile-one", "profile-two"]);
});

// Keeps Forge path validation while sending gateway-compatible tool schemas to OpenAI.
test("omits unsupported path lookahead only from model-facing tool schemas", async () => {
  const definitions = [readFileDefinition, writeDiffDefinition, editDiffDefinition];
  let tools;
  const gateway = createOpenAiSdkGateway({
    providerFactory: { async createForAgent(profile) { return { provider: {}, profile: { ...profile, reasoning: { effort: "none" } } }; } },
    runner: async (agent) => { tools = agent.tools; return { finalOutput: "OK" }; }
  });
  await gateway.execute({
    agent: { agent_id: "architect", agent_name: "Architect", role: "architecture_manager", gateway_url: "https://gateway.test/v1", credential_ref: "profile-key", model: "gpt-4o-mini" },
    correlationId: "SCHEMA-TEST",
    prompt: "hello",
    options: { forgeTools: { definitions, registry: {}, context: {} } }
  });
  assert.equal(tools.length, 3);
  for (const [index, definition] of definitions.entries()) {
    assert.equal(tools[index].parameters.properties.path.pattern, undefined);
    assert.match(definition.input_schema.properties.path.pattern, /\(\?!/);
  }
  assert.equal(tools[1].parameters.properties.before_checksum.pattern, writeDiffDefinition.input_schema.properties.before_checksum.pattern);
});

test("Ollama architecture profiles use Chat Completions and never receive hosted web search", async () => {
  let agentOptions;
  const ollamaProfile = { agent_id: "architect", agent_name: "Architect", role: "architecture_manager", provider: "ollama", gateway_url: "https://ollama.com/v1", credential_ref: "ollama-key", model: "gpt-oss:120b", use_responses: false, reasoning: { effort: "none" } };
  const gateway = createOpenAiSdkGateway({
    providerFactory: { async createForAgent() { return { provider: {}, profile: ollamaProfile }; } },
    AgentClass: class FakeAgent { constructor(options) { agentOptions = options; } },
    runner: async () => ({ finalOutput: "Found the source." })
  });
  await gateway.execute({ agent: ollamaProfile, correlationId: "CORR-OLLAMA-ARCH", prompt: "Search the project", options: { builtinWebSearch: true } });
  assert.deepEqual(agentOptions.tools, []);
  assert.equal(gateway.builtinWebSearchAvailable(ollamaProfile), false);
});

test("passes owner cancellation to the OpenAI-compatible SDK runner", async () => {
  const controller = new AbortController();
  let runSignal;
  const gateway = createOpenAiSdkGateway({
    providerFactory: { async createForAgent(profile) { return { provider: {}, profile: { ...profile, reasoning: { effort: "none" } } }; } },
    runner: async (_agent, _prompt, options) => {
      runSignal = options.signal;
      controller.abort(new Error("Owner cancelled."));
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
  });
  await assert.rejects(() => gateway.execute({
    agent: { agent_id: "architect", agent_name: "Architect", role: "architecture_manager", provider: "ollama", gateway_url: "https://ollama.com/v1", credential_ref: "ollama-key", model: "gpt-oss:120b" },
    correlationId: "CORR-OLLAMA-ABORT", prompt: "Search the project", abortSignal: controller.signal
  }), /Owner cancelled/);
  assert.equal(runSignal.aborted, true);
});
