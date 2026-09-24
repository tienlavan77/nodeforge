import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaSdkProviderFactory, normalizeGatewayUrl, sdkChatUrl } from "../../src/modules/agent/ollama-sdk-provider.js";

test("normalizes gateway urls to bare-host form", async () => {
  assert.equal(normalizeGatewayUrl("https://ollama.com"), "https://ollama.com");
  assert.equal(normalizeGatewayUrl("https://ollama.com/"), "https://ollama.com");
  assert.equal(normalizeGatewayUrl("https://ollama.com/v1"), "https://ollama.com");
  assert.equal(normalizeGatewayUrl("https://ollama.com/v1/chat/completions"), "https://ollama.com");
  assert.equal(normalizeGatewayUrl("https://ollama.com/api/chat"), "https://ollama.com");
});

test("derives the native chat url from stored gateway", async () => {
  assert.equal(sdkChatUrl("https://ollama.com"), "https://ollama.com/api/chat");
  assert.equal(sdkChatUrl("https://ollama.com/v1/chat/completions"), "https://ollama.com/api/chat");
});

test("rejects non-https gateway urls", async () => {
  assert.throws(() => normalizeGatewayUrl("http://ollama.com"), /HTTPS/);
});

test("resolves credentials and keeps the bare host", async () => {
  const factory = createOllamaSdkProviderFactory({
    credentialResolver: async (reference) => {
      assert.equal(reference, "runtime:ollama:api-key");
      return "ollama-secret";
    }
  });
  const { provider, profile } = await factory.createForAgent({
    agent_id: "scout",
    agent_name: "Scout",
    role: "coder",
    gateway_url: "https://ollama.com",
    credential_ref: "runtime:ollama:api-key",
    model: "qwen3:8b"
  });
  assert.equal(profile.gateway_url, "https://ollama.com");
  assert.equal(profile.model, "qwen3:8b");
  assert.equal(provider.apiKey, "ollama-secret");
});

test("requires profile fields and available credentials", async () => {
  const factory = createOllamaSdkProviderFactory({ credentialResolver: async () => "" });
  await assert.rejects(() => factory.createForAgent({
    agent_id: "scout", agent_name: "Scout", role: "coder",
    gateway_url: "https://ollama.com", credential_ref: "missing", model: "qwen3:8b"
  }), /credential is unavailable/);
  await assert.rejects(() => factory.createForAgent({
    agent_id: "scout", agent_name: "Scout", role: "coder",
    gateway_url: "https://ollama.com", credential_ref: "ref", model: ""
  }), /model is required/);
});
