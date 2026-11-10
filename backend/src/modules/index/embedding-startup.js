/**
 * Prepares durable semantic indexing after a provider upgrade without rebuilding
 * source indexes. Cleanup, interrupted-job recovery and summary-only backfill run
 * in one SQLite transaction before any worker can claim an obsolete model job.
 */
import { purposeSummaryInput } from "./purpose-summary-input.js";

/**
 * Preserves matching vectors and active jobs across restarts, while enqueueing
 * summaries whose model or checksum lacks a usable vector. Returns recovery
 * counts for runtime logs; never updates files, symbols, or summary text.
 */
const activeEmbeddingProviders = new WeakMap();

/**
 * Business purpose: tracks active project runtimes sharing an embedding provider instance so closing one project never disposes a provider still used by another project.
 * Technical description: increments the per-provider reference count in a WeakMap when a project runtime starts using the provider.
 */
export function retainEmbeddingProvider(provider) {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return provider;
  activeEmbeddingProviders.set(provider, (activeEmbeddingProviders.get(provider) ?? 0) + 1);
  return provider;
}

/**
 * Business purpose: releases a project runtime's reference to an embedding provider and closes it only when no other active project runtime shares it.
 * Technical description: decrements the WeakMap reference count and invokes provider.close() only when the count reaches zero.
 */
export async function releaseEmbeddingProvider(provider) {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return;
  const current = activeEmbeddingProviders.get(provider) ?? 0;
  if (current > 1) {
    activeEmbeddingProviders.set(provider, current - 1);
    return;
  }
  activeEmbeddingProviders.delete(provider);
  await provider.close?.();
}

export function prepareEmbeddingQueue({ database, embeddingStore, jobs, model }) {
  if (typeof model !== "string" || !model.trim()) throw new Error("Embedding startup requires a model tag.");
  /** Commits the model transition atomically so startup cannot expose a half-cleaned queue. */
  function prepare() {
    const removedVectors = embeddingStore.removeOtherModels(model);
    const removedJobs = jobs.removeOtherModels(model);
    const recovered = jobs.recoverProcessing();
    let queued = 0;
    for (const symbol of database.all(`SELECT s.symbol_id, s.name, s.kind, s.summary, f.path, e.embedding_model, e.content_checksum
      FROM symbols s LEFT JOIN files f ON f.file_id = s.file_id LEFT JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id`)) {
      const input = purposeSummaryInput({ summary: symbol.summary, path: symbol.path, name: symbol.name, kind: symbol.kind });
      const plainChecksum = purposeSummaryInput(symbol.summary)?.checksum;
      if (!input || (symbol.embedding_model === model && (symbol.content_checksum === input.checksum || symbol.content_checksum === plainChecksum))) continue;
      jobs.enqueue({ symbolId: symbol.symbol_id, contentChecksum: input.checksum, model });
      queued += 1;
    }
    return { removedVectors, removedJobs, recovered, queued };
  }
  return database.transaction ? database.transaction(prepare) : prepare();
}
