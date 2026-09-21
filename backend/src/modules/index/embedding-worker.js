// Processes durable embedding jobs and writes vectors through the embedding store.
import { ConfigurationError } from "../../shared/errors.js";
import { checksumEmbeddingText } from "./embedding-job-store.js";

// Creates a single-flight Embedding Worker for a project index database.
export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddingProvider, model, clock = () => new Date(), maxAttempts = 5, retryDelayMs = 30000, logger = console } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Embedding worker requires a database.");
  if (!jobs || typeof jobs.claimNext !== "function") throw new ConfigurationError("Embedding worker requires an embedding job store.");
  if (!embeddingStore || typeof embeddingStore.upsert !== "function") throw new ConfigurationError("Embedding worker requires an embedding store.");
  if (!embeddingProvider || typeof embeddingProvider.embed !== "function") throw new ConfigurationError("Embedding worker requires an embedding provider.");
  if (typeof model !== "string" || !model) throw new ConfigurationError("Embedding worker model is required.");
  let stopped = false;
  let running = false;
  return Object.freeze({ runOnce, start, stop });

  // Claims and processes one ready job, returning whether work was performed.
  async function runOnce() {
    if (running) return false;
    running = true;
    let activeJob = null;
    try {
      activeJob = jobs.claimNext({ now: clock().toISOString() });
      if (!activeJob) return false;
      const symbol = database.all(
        `SELECT s.name, s.kind, sc.content FROM symbols s LEFT JOIN symbol_content_fts sc ON sc.symbol_id = s.symbol_id WHERE s.symbol_id = ?`,
        [activeJob.symbol_id]
      )[0];
      if (!symbol) {
        jobs.supersede(activeJob.job_id);
        return true;
      }
      const content = symbol.content ?? "";
      const checksum = checksumEmbeddingText(`${symbol.name}\n${symbol.kind}\n${content}`);
      if (checksum !== activeJob.content_checksum || activeJob.model !== model) {
        jobs.supersede(activeJob.job_id);
        return true;
      }
      const vector = await embeddingProvider.embed(`${symbol.name} [${symbol.kind}]\n${content}`.slice(0, 4000));
      embeddingStore.upsert({ symbolId: activeJob.symbol_id, vector, model, checksum });
      jobs.complete(activeJob.job_id);
      return true;
    } catch (error) {
      if (activeJob?.job_id) jobs.retry(activeJob.job_id, error, { maxAttempts, delayMs: retryDelayMs });
      logger.warning?.("Embedding job failed.", { error: error.message });
      return true;
    } finally {
      running = false;
    }
  }

  // Runs the worker loop with a bounded polling interval.
  async function start({ pollMs = 1000 } = {}) {
    stopped = false;
    while (!stopped) {
      const worked = await runOnce();
      if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // Requests a clean stop after the current Ollama request finishes.
  function stop() {
    stopped = true;
  }
}
