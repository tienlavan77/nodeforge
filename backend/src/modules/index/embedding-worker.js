// Processes durable embedding jobs and writes vectors through the embedding store.
import { ConfigurationError } from "../../shared/errors.js";
import { purposeSummaryInput } from "./purpose-summary-input.js";

// Creates a single-flight Embedding Worker for a project index database.
export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddingProvider, model, clock = () => new Date(), maxAttempts = 5, retryDelayMs = 30000, logger = console } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Embedding worker requires a database.");
  if (!jobs || typeof jobs.claimNext !== "function") throw new ConfigurationError("Embedding worker requires an embedding job store.");
  if (!embeddingStore || typeof embeddingStore.upsert !== "function") throw new ConfigurationError("Embedding worker requires an embedding store.");
  if (!embeddingProvider || typeof embeddingProvider.embed !== "function") throw new ConfigurationError("Embedding worker requires an embedding provider.");
  if (typeof model !== "string" || !model) throw new ConfigurationError("Embedding worker model is required.");
  let stopped = false;
  let running = false;
  let loopTask;
  let wake;
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
        `SELECT summary FROM symbols WHERE symbol_id = ?`,
        [activeJob.symbol_id]
      )[0];
      const input = purposeSummaryInput(symbol?.summary);
      if (!input) {
        jobs.supersede(activeJob.job_id);
        return true;
      }
      const { content, checksum } = input;
      if (checksum !== activeJob.content_checksum || activeJob.model !== model) {
        jobs.supersede(activeJob.job_id);
        return true;
      }
      const vector = await embeddingProvider.embed(content);
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
  function start({ pollMs = 1000 } = {}) {
    if (loopTask) return loopTask;
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new ConfigurationError("Worker poll interval must be positive.");
    stopped = false;
    loopTask = loop(pollMs).finally(() => { loopTask = undefined; });
    return loopTask;
  }

  // Drains this project's embedding queue without leaving a polling timer after removal.
  async function loop(pollMs) {
    while (!stopped) {
      const worked = await runOnce();
      if (!worked && !stopped) await new Promise((resolveWait) => {
        const timer = setTimeout(finish, pollMs);
        // Wakes the idle worker immediately when the project is removed.
        function finish() { clearTimeout(timer); wake = undefined; resolveWait(); }
        wake = finish;
      });
    }
  }

  // Requests a clean stop after the current Ollama request finishes.
  function stop() {
    stopped = true;
    wake?.();
    return loopTask;
  }
}
