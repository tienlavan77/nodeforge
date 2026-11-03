/**
 * Runs semantic retrieval locally so symbol indexing does not depend on an Ollama
 * server. All project providers share one lazy, quantized Nomic ONNX pipeline and
 * a repository-local disk cache; closing a project never disposes shared inference.
 */
import { fileURLToPath } from "node:url";

export const ONNX_EMBEDDING_MODEL = "Xenova/nomic-embed-text-v1.5";
export const ONNX_MODEL_CACHE = fileURLToPath(new URL("../../../../.forge/models/", import.meta.url));
const pipelines = new WeakMap();

/** Loads Transformers only on first inference, keeping Control API startup responsive. */
async function loadTransformers() {
  return import("@xenova/transformers");
}

/**
 * Shares an in-flight initialization promise across projects and searches. Failed
 * downloads are evicted so the durable worker's retry can attempt loading again.
 */
function sharedPipeline(load) {
  if (!pipelines.has(load)) {
    const pending = (async () => {
      const { pipeline } = await load();
      return pipeline("feature-extraction", ONNX_EMBEDDING_MODEL, {
        quantized: true, cache_dir: ONNX_MODEL_CACHE
      });
    })().catch((error) => {
      pipelines.delete(load);
      throw error;
    });
    pipelines.set(load, pending);
  }
  return pipelines.get(load);
}

/**
 * Supplies normalized 768-dimensional document vectors from purpose summaries.
 * Query callers may select Nomic's search_query prefix through an optional second
 * argument without changing the existing model/embed interface used by workers.
 * The loader seam permits contract tests without downloading production weights.
 */
export function createOnnxEmbeddingProvider({ load = loadTransformers } = {}) {
  return Object.freeze({
    model: ONNX_EMBEDDING_MODEL,
    /** Applies Nomic task prefixes and rejects malformed inference before storage. */
    async embed(text, { purpose = "document" } = {}) {
      if (typeof text !== "string" || !text.trim()) throw new Error("Embedding text must be nonempty.");
      const extractor = await sharedPipeline(load);
      const prefix = purpose === "query" ? "search_query" : "search_document";
      const output = await extractor(`${prefix}: ${text.trim()}`, { pooling: "mean", normalize: true });
      const vector = Array.from(output.data);
      if (vector.length !== 768 || !vector.every(Number.isFinite)) {
        throw new Error("Nomic embedding must contain 768 finite values.");
      }
      const norm = Math.hypot(...vector);
      if (!Number.isFinite(norm) || norm === 0) throw new Error("Nomic embedding has invalid norm.");
      return vector.map((value) => value / norm);
    }
  });
}
