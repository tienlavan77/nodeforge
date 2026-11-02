// Processes durable embedding jobs and writes vectors through the embedding store.
import { ConfigurationError } from "../../shared/errors.js";
import { purposeSummaryInput } from "./purpose-summary-input.js";

// Creates a single-flight Embedding Worker for a project index database.
export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddingProvider, model, clock = () => new Date(), maxAttempts = 5, retryDelayMs = 30000, logger = console, onJobClaimed = null, onJobSettled = null } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Embedding worker requires a database.");
  if (!jobs || typeof jobs.claimNext !== "function") throw new ConfigurationError("Embedding worker requires an embedding job store.");
  if (!embeddingStore || typeof embeddingStore.upsert !== "function") throw new ConfigurationError("Embedding worker requires an embedding store.");
  if (!embeddingProvider || typeof embeddingProvider.embed !== "function") throw new ConfigurationError("Embedding worker requires an embedding provider.");
  if (typeof model !== "string" || !model) throw new ConfigurationError("Embedding worker model is required.");
  let stopped = false;
  let running = false;
  let notified = false;
  let activeRun;
  let loopTask;
  let wake;
  return Object.freeze({ runOnce, start, stop, notify });

  // Claims and processes one ready job, returning whether work was performed.
  function runOnce() {
    if (running) return Promise.resolve(false);
    running = true;
    activeRun = processNextJob().finally(() => {
      running = false;
      activeRun = undefined;
    });
    return activeRun;
  }

  // Claims the next ready embedding job from the durable SQLite queue, validates the current symbol purpose summary checksum, computes its vector via embeddingProvider, and persists the vector atomically or schedules a retry on failure.
  async function processNextJob() {
    let activeJob = null;
    let outcome = "superseded";
    try {
      activeJob = jobs.claimNext({ now: clock().toISOString() });
      if (!activeJob) return false;
      onJobClaimed?.(activeJob);
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
      // Publishes only while both the summary and claimed job remain current.
      // The synchronous transaction closes the cross-process check/write race.
      const publish = () => {
        const current = database.all("SELECT summary FROM symbols WHERE symbol_id = ?", [activeJob.symbol_id])[0];
        const job = database.all("SELECT status FROM embedding_jobs WHERE job_id = ?", [activeJob.job_id])[0];
        if (purposeSummaryInput(current?.summary)?.checksum !== checksum || job?.status !== "processing") {
          jobs.supersede(activeJob.job_id);
          return;
        }
        embeddingStore.upsert({ symbolId: activeJob.symbol_id, vector, model, checksum });
        jobs.complete(activeJob.job_id);
        outcome = "completed";
      };
      if (database.transaction) database.transaction(publish);
      else publish();
      return true;
    } catch (error) {
      outcome = "failed";
      if (activeJob?.job_id) jobs.retry(activeJob.job_id, error, { maxAttempts, delayMs: retryDelayMs });
      logger.warning?.("Embedding job failed.", { error: error.message });
      return true;
    } finally {
      if (activeJob) onJobSettled?.(activeJob, { status: outcome });
    }
  }

  // Wakes the idle embedding worker immediately when new symbol summary work is pushed from the watcher worker so vector generation starts without waiting for the polling interval.
  function notify() {
    notified = true;
    wake?.();
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
      notified = false;
      const worked = await runOnce();
      if (!worked && !stopped && !notified) await new Promise((resolveWait) => {
        const timer = setTimeout(finish, pollMs);
        // Wakes the idle worker immediately when the project is removed or notified.
        function finish() { clearTimeout(timer); wake = undefined; resolveWait(); }
        wake = finish;
      });
    }
  }

  // Requests a clean stop after the current Ollama request finishes.
  function stop() {
    stopped = true;
    wake?.();
    return loopTask ?? activeRun;
  }
}
