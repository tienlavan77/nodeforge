import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiSdkProviderFactory, normalizeGatewayUrl, normalizeReasoningEffort } from "../../src/modules/agent/openai-sdk-provider.js";

test("normalizes OpenAI SDK gateway base URLs", () => {
  assert.equal(normalizeGatewayUrl("https://gateway.example.test"), "https://gateway.example.test/v1");
  assert.equal(normalizeGatewayUrl("https://gateway.example.test/v1/responses"), "https://gateway.example.test/v1");
  assert.equal(normalizeGatewayUrl("https://gateway.example.test/v2/"), "https://gateway.example.test/v2");
  assert.throws(() => normalizeGatewayUrl("http://insecure.example.test"), /HTTPS/);
});

test("normalizes supported reasoning effort values", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.throws(() => normalizeReasoningEffort("turbo"), /reasoning effort is invalid/);
});

test("creates an isolated OpenAI SDK provider from an agent profile", async () => {
  let constructorOptions;
  class FakeProvider {
    constructor(options) { constructorOptions = options; }
  }
  const factory = createOpenAiSdkProviderFactory({
    ProviderClass: FakeProvider,
    credentialResolver: async (reference) => {
      assert.equal(reference, "secret:agent:builder");
      return "gateway-secret";
    }
  });
  const result = await factory.createForAgent({
    agent_id: "builder",
    agent_name: "Builder",
    role: "coder",
    gateway_url: "https://gateway.example.test/v1/responses",
    credential_ref: "secret:agent:builder",
    model: "gpt-5.6-sol",
    reasoning: { effort: "high" }
  });
  assert.equal(constructorOptions.apiKey, "gateway-secret");
  assert.equal(constructorOptions.baseURL, "https://gateway.example.test/v1");
  assert.equal(constructorOptions.useResponses, false);
  assert.equal(constructorOptions.strictFeatureValidation, false);
  assert.deepEqual(result.profile.reasoning, { effort: "high" });
  assert.equal(result.profile.model, "gpt-5.6-sol");
});

test("does not accept an incomplete OpenAI SDK profile", async () => {
  const factory = createOpenAiSdkProviderFactory({ ProviderClass: class {}, credentialResolver: () => "secret" });
  await assert.rejects(() => factory.createForAgent({ agent_id: "builder" }), /gateway URL/);
});
