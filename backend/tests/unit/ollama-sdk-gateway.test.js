import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaSdkGateway } from "../../src/modules/agent/ollama-sdk-gateway.js";

function profile() {
  return { agent_id: "scout", agent_name: "Scout", role: "coder", gateway_url: "https://ollama.com", model: "gemma4:31b-cloud" };
}

function factory() {
  return {
    async createForAgent(input) {
      assert.equal(input.agent_id, "scout");
      return { provider: { apiKey: "ollama-secret" }, profile: profile() };
    }
  };
}

function query(messages) {
  return (async function* () { for (const message of messages) yield message; })();
}

test("runs a prompt through the claude sdk against the ollama base url", async () => {
  let request;
  const gateway = createOllamaSdkGateway({
    providerFactory: factory(),
    queryFn: ({ prompt, options }) => {
      request = { prompt, options };
      return query([{ type: "assistant", message: { content: [{ type: "text", text: "Hello from Scout." }] } }]);
    },
    environment: { PATH: "/usr/bin" }
  });
  const result = await gateway.execute({
    agent: { agent_id: "scout" },
    correlationId: "CORR-OLLAMA",
    prompt: "Say hello to the NodeForge Supervisor."
  });
  assert.equal(request.prompt, "Say hello to the NodeForge Supervisor.");
  assert.equal(request.options.model, "gemma4:31b-cloud");
  assert.equal(request.options.env.ANTHROPIC_BASE_URL, "https://ollama.com");
  assert.equal(request.options.env.ANTHROPIC_AUTH_TOKEN, "ollama-secret");
  assert.equal(request.options.env.ANTHROPIC_API_KEY, "");
  assert.equal(result.text, "Hello from Scout.");
  assert.equal(result.agent_id, "scout");
  assert.equal(result.correlation_id, "CORR-OLLAMA");
});

test("redacts credentials from sdk failures", async () => {
  const gateway = createOllamaSdkGateway({
    providerFactory: factory(),
    queryFn: () => { throw new Error("boom ollama-secret"); },
    environment: {}
  });
  await assert.rejects(() => gateway.execute({ agent: { agent_id: "scout" }, correlationId: "c", prompt: "hi" }), /boom \[REDACTED\]/);
});

test("requires prompt and correlation id", async () => {
  const gateway = createOllamaSdkGateway({
    providerFactory: factory(),
    queryFn: () => query([]),
    environment: {}
  });
  await assert.rejects(() => gateway.execute({ agent: { agent_id: "scout" }, correlationId: "c", prompt: " " }), /prompt is required/);
  await assert.rejects(() => gateway.execute({ agent: { agent_id: "scout" }, prompt: "hi" }), /correlation_id is required/);
});
