// Verifies complete summary transport and explicit provider failures without truncation.
import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaEmbeddingProvider } from "../../src/modules/index/ollama-embedding-provider.js";

test("provider sends complete Unicode summaries and disables server truncation", async () => {
  const summary = "Preserve customer obligations 日本語. ".repeat(500) + "FINAL WARNING";
  const requests = [];
  const provider = createOllamaEmbeddingProvider({
    baseUrl: "http://provider", model: "unchanged-model",
    // Captures the actual transport contract independently of input size.
    async fetchFn(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ embeddings: [[1, 2]] }) };
    }
  });
  assert.deepEqual(await provider.embed(summary), [1, 2]);
  assert.deepEqual(requests, [{ url: "http://provider/api/embed", body: { model: "unchanged-model", input: summary, truncate: false } }]);
  await provider.close();
});

test("unprocessable input rejects explicitly and leaves the queue usable", async () => {
  const summary = "Complete purpose. ".repeat(800);
  const inputs = [];
  const provider = createOllamaEmbeddingProvider({
    // Simulates a provider refusing an oversized input, followed by a valid request.
    async fetchFn(url, options) {
      inputs.push(JSON.parse(options.body).input);
      return inputs.length === 1 ? { ok: false, status: 413 }
        : { ok: true, json: async () => ({ embeddings: [[1]] }) };
    }
  });
  await assert.rejects(provider.embed(summary), /413/);
  assert.equal(inputs[0], summary);
  assert.deepEqual(await provider.embed("Next complete purpose."), [1]);
  await assert.rejects(provider.embed(" "), /required/);
  await provider.close();
});
