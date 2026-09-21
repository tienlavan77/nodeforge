// Shared composition root for lexical, graph, and Ollama retrieval dependencies.
import { createCodeSearch } from "./code-search.js";
import { createFileGraph } from "./file-graph.js";
import { createEmbeddingStore } from "./embedding-store.js";
import { createOllamaEmbeddingProvider } from "./ollama-embedding-provider.js";

const DEFAULT_OLLAMA_BASE_URL = "http://192.168.1.180:11434";
const DEFAULT_OLLAMA_MODEL = "embeddinggemma";
const DEFAULT_OLLAMA_TIMEOUT_MS = 300000;

// Creates the retrieval dependencies used by production and evaluation entrypoints.
export function createRetrievalDependencies({ database, ollamaConfig = {} } = {}) {
  const config = resolveOllamaConfig(ollamaConfig);
  const search = createCodeSearch({ database });
  const fileGraph = createFileGraph({ database });
  const embeddingStore = createEmbeddingStore({ database });
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  return Object.freeze({ search, fileGraph, embeddingStore, embeddingProvider, ollamaConfig: Object.freeze(config) });
}

// Resolves one shared Ollama configuration from explicit values and environment defaults.
export function resolveOllamaConfig(overrides = {}) {
  return {
    baseUrl: overrides.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    model: overrides.model ?? process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_OLLAMA_MODEL,
    timeoutMs: Number(overrides.timeoutMs ?? process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_OLLAMA_TIMEOUT_MS)
  };
}
