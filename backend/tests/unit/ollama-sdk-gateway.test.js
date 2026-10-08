// Summary: Verifies Ollama owner agents use compatible OpenAI function calling for governed Forge tools.
import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaSdkGateway } from "../../src/modules/agent/ollama-sdk-gateway.js";

// Builds an Ollama profile served by an OpenAI-compatible gateway.
function profile() {
  return { agent_id: "scout", agent_name: "Scout", role: "architecture_manager", provider: "ollama", gateway_url: "https://ollama.com/v1", model: "gpt-oss:120b" };
}

test("routes Ollama execution through OpenAI-compatible function calling with Forge options", async () => {
  let request;
  const openaiSdkGateway = {
    provider: "openai",
    conversationMode: "history",
    async execute(input) {
      request = input;
      return { agent_id: "scout", status: "completed", text: "Found the requested file." };
    }
  };
  const gateway = createOllamaSdkGateway({ openaiSdkGateway });
  const abortSignal = new AbortController().signal;
  const options = { forgeTools: { definitions: [{ name: "read_file" }] }, builtinWebSearch: false };
  const result = await gateway.execute({
    agent: profile(), correlationId: "CORR-OLLAMA", prompt: "Read the project file.", cwd: "/repo", options,
    abortSignal
  });
  assert.deepEqual(request, {
    agentId: "scout", agent: profile(), correlationId: "CORR-OLLAMA", prompt: "Read the project file.", cwd: "/repo", options,
    resumeThreadId: undefined, onEvent: undefined, onSessionReady: undefined, abortSignal
  });
  assert.equal(gateway.provider, "ollama");
  assert.equal(gateway.conversationMode, "history");
  assert.equal(gateway.builtinWebSearchAvailable, false);
  assert.equal(result.text, "Found the requested file.");
});

test("requires Ollama profile identity, prompt, and correlation id", async () => {
  const gateway = createOllamaSdkGateway({ openaiSdkGateway: { execute: async () => ({}) } });
  await assert.rejects(() => gateway.execute({ agent: {}, correlationId: "c", prompt: "hi" }), /agent_id is required/);
  await assert.rejects(() => gateway.execute({ agent: profile(), correlationId: "c", prompt: " " }), /prompt is required/);
  await assert.rejects(() => gateway.execute({ agent: profile(), prompt: "hi" }), /correlation_id is required/);
});

test("requires the OpenAI-compatible SDK gateway", () => {
  assert.throws(() => createOllamaSdkGateway(), /requires the OpenAI-compatible SDK gateway/);
});
