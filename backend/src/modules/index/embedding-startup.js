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
export function prepareEmbeddingQueue({ database, embeddingStore, jobs, model }) {
  if (typeof model !== "string" || !model.trim()) throw new Error("Embedding startup requires a model tag.");
  /** Commits the model transition atomically so startup cannot expose a half-cleaned queue. */
  function prepare() {
    const removedVectors = embeddingStore.removeOtherModels(model);
    const removedJobs = jobs.removeOtherModels(model);
    const recovered = jobs.recoverProcessing();
    let queued = 0;
    for (const symbol of database.all(`SELECT s.symbol_id, s.summary, e.embedding_model, e.content_checksum
      FROM symbols s LEFT JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id`)) {
      const input = purposeSummaryInput(symbol.summary);
      if (!input || (symbol.embedding_model === model && symbol.content_checksum === input.checksum)) continue;
      jobs.enqueue({ symbolId: symbol.symbol_id, contentChecksum: input.checksum, model });
      queued += 1;
    }
    return { removedVectors, removedJobs, recovered, queued };
  }
  return database.transaction(prepare);
}
