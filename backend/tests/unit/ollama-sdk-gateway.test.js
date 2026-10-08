// Ensures Ollama OpenAI models use the Codex SDK execution path and retain resumable sessions.
import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaSdkGateway } from "../../src/modules/agent/ollama-sdk-gateway.js";

// Builds an Ollama profile with a model served through its OpenAI-compatible endpoint.
function profile() {
  return { agent_id: "scout", agent_name: "Scout", role: "coder", provider: "ollama", gateway_url: "https://ollama.com", model: "gpt-oss:120b" };
}

test("routes Ollama profile execution through Codex SDK with resume and tool options", async () => {
  let request;
  const codexSdkGateway = {
    provider: "codex",
    conversationMode: "thread",
    async execute(input) {
      request = input;
      return { agent_id: "scout", status: "completed", text: "Hello from Scout.", thread_id: "thread-1" };
    }
  };
  const gateway = createOllamaSdkGateway({ codexSdkGateway });
  const onEvent = () => {};
  const onSessionReady = () => {};
  const abortSignal = new AbortController().signal;
  const options = { forgeTools: { definitions: [{ name: "read_file" }] } };
  const result = await gateway.execute({
    agent: profile(), correlationId: "CORR-OLLAMA", prompt: "Say hello.", cwd: "/repo", options,
    resumeThreadId: "thread-0", onEvent, onSessionReady, abortSignal
  });
  assert.deepEqual(request, {
    agentId: "scout", agent: profile(), correlationId: "CORR-OLLAMA", prompt: "Say hello.", cwd: "/repo", options,
    resumeThreadId: "thread-0", onEvent, onSessionReady, abortSignal
  });
  assert.equal(gateway.provider, "ollama");
  assert.equal(gateway.conversationMode, "thread");
  assert.equal(gateway.builtinWebSearchAvailable, false);
  assert.equal(result.text, "Hello from Scout.");
});

test("requires Ollama profile identity, prompt, and correlation id", async () => {
  const gateway = createOllamaSdkGateway({ codexSdkGateway: { execute: async () => ({}) } });
  await assert.rejects(() => gateway.execute({ agent: {}, correlationId: "c", prompt: "hi" }), /agent_id is required/);
  await assert.rejects(() => gateway.execute({ agent: profile(), correlationId: "c", prompt: " " }), /prompt is required/);
  await assert.rejects(() => gateway.execute({ agent: profile(), prompt: "hi" }), /correlation_id is required/);
});

test("requires the Codex SDK gateway", () => {
  assert.throws(() => createOllamaSdkGateway(), /requires the Codex SDK gateway/);
});
