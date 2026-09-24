// Calls a local Ollama embeddings endpoint (LAN) with a serial queue.
// Single in-flight request (concurrency=1) so bulk reindex cannot flood a weak box.
// Short timeout + throw lets callers fall back without blocking the pipeline.
import { ConfigurationError } from "../../shared/errors.js";

// Creates an Ollama embedding provider (POST /api/embeddings {model, prompt}).
export function createOllamaEmbeddingProvider({ baseUrl = "http://192.168.1.180:11434", model = "all-minilm", fetchFn = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl) throw new ConfigurationError("Ollama embedding provider requires a base URL.");
  if (typeof model !== "string" || !model) throw new ConfigurationError("Ollama embedding provider requires a model tag.");
  let tail = Promise.resolve();
  return Object.freeze({ embed, model: () => model });

  function embed(text) {
    const job = tail.then(() => requestOnce(text));
    // Keep the queue alive even if one job rejects; callers still see their error.
    // eslint-disable-next-line no-silent-catch -- Queue keep-alive; callers still receive their own job error.
    tail = job.catch(() => {});
    return job;
  }

  async function requestOnce(text) {
    if (typeof text !== "string" || !text.trim()) throw new ConfigurationError("Embedding text is required.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text.slice(0, 4000) }),
        signal: controller.signal
      });
      if (!response.ok) throw new ConfigurationError(`Ollama embedding failed: ${response.status}.`);
      const payload = await response.json();
      const vector = payload?.embedding;
      if (!Array.isArray(vector) || !vector.length) throw new ConfigurationError("Ollama embedding has no vector.");
      return vector.map(Number);
    } finally {
      clearTimeout(timer);
    }
  }
}
