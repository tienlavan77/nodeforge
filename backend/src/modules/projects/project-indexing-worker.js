// Runs project comment normalization, baseline code indexing, file watching, and vector embedding inside a dedicated Worker Thread.
// Business purpose: isolates CPU-intensive AST parsing, comment normalization, SQLite index writes, and embedding vector generation from the Control API main thread so adding or indexing a project never blocks Forge HTTP APIs or SSE streams.
// Technical description: opens the project's SQLite index database inside `node:worker_threads`, runs `startProjectWatch` and `createEmbeddingWorker`, and relays progress snapshots, watcher events, and embedding status to the parent thread via `parentPort`.
import { EventEmitter } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { createIndexProgress } from "../index/index-progress.js";
import { ensureRuntimeDir, openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { INDEX_RUNTIME_DIR, indexDatabaseExists, startProjectWatch } from "../watcher/watch-project.js";
import { createEmbeddingJobStore } from "../index/embedding-job-store.js";
import { prepareEmbeddingQueue, releaseEmbeddingProvider, retainEmbeddingProvider } from "../index/embedding-startup.js";
import { createEmbeddingWorker } from "../index/embedding-worker.js";
import { createRetrievalDependencies } from "../index/retrieval-dependencies.js";

let database, watch, worker, embeddingJobs, retrieval, embeddingProvider, workerTask;
let closed = false, closing, embeddingError = null, providerRetained = false;

// Sends a structured message to the Control API parent thread when the worker channel is open.
// Business purpose: streams background indexing and embedding state transitions back to the main process without sharing synchronous state.
// Technical description: posts a JSON-serializable envelope over `parentPort` and ignores post errors after worker teardown begins.
function postToParent(type, payload = {}) {
  try {
    parentPort?.postMessage({ type, ...payload });
    // eslint-disable-next-line no-silent-catch -- Best-effort parent notification during worker shutdown.
  } catch { /* Ignore postMessage failures after the parent channel closes. */ }
}

// Formats metadata errors into serializable structures before posting across the thread boundary.
// Business purpose: ensures Error instances logged inside the worker retain their message and code in Control API logs.
// Technical description: clones metadata and converts `error` properties into `{ message, code, stack }`.
function serializeMeta(meta = {}) {
  if (!meta || typeof meta !== "object") return {};
  const copy = { ...meta };
  if (copy.error instanceof Error) copy.error = { message: copy.error.message, code: copy.error.code, stack: copy.error.stack };
  return copy;
}

// Creates a logger proxy that forwards background worker logs to the parent thread.
// Business purpose: preserves structured project runtime and embedding observability logs in the Control API log stream while executing off the main thread.
// Technical description: serializes error objects into plain records and posts `log` messages over `parentPort`.
function createWorkerThreadLogger(projectId) {
  // Posts a single log entry with level and serialized metadata to the parent thread.
  // Business purpose: centralizes log forwarding across info, warn, and error levels.
  // Technical description: invokes `postToParent("log", ...)` with normalized metadata.
  const send = (level, message, meta) => postToParent("log", { level, message, meta: serializeMeta(meta), projectId });
  return {
    info: (message, meta) => send("info", message, meta),
    warn: (message, meta) => send("warn", message, meta),
    warning: (message, meta) => send("warn", message, meta),
    error: (message, meta) => send("error", message, meta)
  };
}

// Synchronizes durable SQLite embedding job counts and errors into the worker progress collector.
// Business purpose: keeps live embedding queue metrics accurate for UI progress cards and SSE streams while vector generation runs in the background thread.
// Technical description: queries `embedding_jobs` counts and latest error from the worker's SQLite handle and updates `trackedProgress.embedding`.
function syncEmbeddingProgress(projectId, trackedProgress, workerLogger, job, outcome) {
  if (outcome?.status === "completed") workerLogger.clearEmbeddingError();
  const counts = closed || !embeddingJobs ? null : embeddingJobs.counts();
  if (!counts) return;
  const unresolvedError = !closed && database
    ? database.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null
    : null;
  if (unresolvedError) embeddingError ??= unresolvedError;
  else if (!counts.failed && !counts.retry_wait && outcome?.status !== "failed") embeddingError = null;
  const hasFailure = Boolean(embeddingError || counts.failed || counts.retry_wait);
  trackedProgress.embedding({
    projectId,
    status: hasFailure ? "failed" : counts.pending || counts.processing ? "running" : "succeeded",
    error: embeddingError ? String(embeddingError) : null,
    pending: (counts.pending ?? 0) + (counts.retry_wait ?? 0),
    processing: counts.processing ?? 0,
    succeeded: counts.completed ?? 0,
    failed: counts.failed ?? 0
  });
}

// Stops the background watcher, embedding loop, and SQLite connection cleanly inside the Worker Thread.
// Business purpose: guarantees that removing a project or shutting down Forge releases all file handles, timers, and database locks held by the background thread.
// Technical description: closes the project watcher, stops the embedding worker and provider, closes the SQLite index database, and aggregates any cleanup errors.
async function shutdownWorker() {
  if (closing) return closing;
  closed = true;
  closing = (async () => {
    const errors = [];
    try { await watch?.close(); } catch (error) { errors.push(error); }
    try {
      const runningTask = worker?.stop();
      try {
        if (providerRetained) { providerRetained = false; await releaseEmbeddingProvider(embeddingProvider); }
      } finally { await (workerTask ?? runningTask); }
    } catch (error) { errors.push(error); }
    try { await database?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Project indexing worker cleanup failed.");
  })();
  return closing;
}

// Bootstraps the background indexing, watching, and embedding pipeline for one admitted project.
// Business purpose: executes the full Option B intake pipeline (`comment_normalization` -> `scan/index` -> `resolve` -> `embedding` -> `startup/readiness`) inside the Worker Thread without blocking the Control API.
// Technical description: initializes `openIndexDatabase`, `createEmbeddingWorker`, and `startProjectWatch`, wires internal event forwarding to `parentPort`, and signals readiness or failure.
async function runIndexingWorker() {
  const {
    projectRoot, projectId, ollamaConfig, chokidarOptions,
    normalizeComments = true, rejectOnViolation = true, fallbackOnViolation = false,
    awaitInitialEmbeddings = false, embeddingPollMs = 1000
  } = workerData ?? {};
  const logger = createWorkerThreadLogger(projectId);
  const bus = new EventEmitter();
  for (const eventType of ["watcher.indexed", "watcher.error", "index.result", "agent.activity", "embedding.failed"]) {
    bus.on(eventType, (event) => postToParent("bus_event", { eventType, event }));
  }
  const baseProgress = createIndexProgress({ onProgress: (snapshot) => postToParent("progress", { snapshot }) });
  const trackedProgress = Object.freeze({
    ...baseProgress,
    // Advances the worker progress stage and emits a corresponding Agent Coder activity event.
    // Business purpose: notifies live SSE stream subscribers whenever the background worker transitions to a new intake stage.
    // Technical description: delegates to `baseProgress.stage(value)` and emits `agent.activity` on the worker bus.
    stage(value) {
      const snap = baseProgress.stage(value);
      bus.emit("agent.activity", {
        event_type: "agent.activity", project_id: projectId, timestamp: new Date().toISOString(),
        payload: { agent_id: "coder", activity_type: "progress", status: "working", summary: `Stage ${value}: running` }
      });
      return snap;
    },
    // Marks the worker progress collector as finished and broadcasts terminal stage completion.
    // Business purpose: signals to SSE subscribers that baseline indexing has settled into ready or failed state.
    // Technical description: delegates to `baseProgress.finish()` and emits a terminal `agent.activity` event.
    finish() {
      const snap = baseProgress.finish();
      bus.emit("agent.activity", {
        event_type: "agent.activity", project_id: projectId, timestamp: new Date().toISOString(),
        payload: {
          agent_id: "coder",
          activity_type: snap.status === "failed" ? "failed" : "completed",
          status: snap.status === "failed" ? "failed" : "success",
          summary: `Stage ${snap.stage}: ${snap.status}`
        }
      });
      return snap;
    }
  });
  const workerLogger = {
    // Records transient embedding provider failures and publishes diagnostic status to the parent thread.
    // Business purpose: surfaces Ollama or ONNX embedding errors on the project card without stopping file watching.
    // Technical description: sets `embeddingError`, updates `trackedProgress.embedding`, logs a warning, and emits `embedding.failed`.
    warning(message, detail = {}) {
      embeddingError = detail.error ?? message;
      trackedProgress.embedding({ projectId, status: "failed", error: String(embeddingError) });
      logger.warn(message, { ...detail, projectId });
      bus.emit("embedding.failed", { projectId, error: String(embeddingError) });
    },
    // Clears transient embedding error state once queued jobs succeed and no failed jobs remain.
    // Business purpose: recovers the project's embedding health indicator automatically after transient provider outages resolve.
    // Technical description: queries `embedding_jobs` for remaining failed or retry_wait rows and resets `embeddingError`.
    clearEmbeddingError() {
      embeddingError = !closed && database
        ? database.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null
        : null;
    }
  };

  try {
    const databaseExisted = await indexDatabaseExists(projectRoot);
    if (!databaseExisted) await ensureRuntimeDir(projectRoot);
    database = await openIndexDatabase(projectRoot, { runtimeDir: INDEX_RUNTIME_DIR });
    retrieval = createRetrievalDependencies({ database, ollamaConfig });
    embeddingProvider = retrieval.embeddingProvider;
    retainEmbeddingProvider(embeddingProvider);
    providerRetained = true;
    const model = embeddingProvider.model ?? (ollamaConfig?.model || retrieval.embeddingProvider.model);
    retrieval = { ...retrieval, embeddingModel: model };
    retrieval.embeddingStore.removeOtherModels(model);
    embeddingJobs = createEmbeddingJobStore({
      database,
      // Refreshes embedding queue counts and wakes the worker loop whenever a symbol summary job is enqueued.
      // Business purpose: starts vector calculation immediately when new or modified symbols are indexed.
      // Technical description: calls `syncEmbeddingProgress` and `worker.notify()`.
      onEnqueue() { syncEmbeddingProgress(projectId, trackedProgress, workerLogger); worker?.notify?.(); }
    });
    embeddingJobs.removeOtherModels(model);
    embeddingJobs.recoverProcessing();
    worker = createEmbeddingWorker({
      database, jobs: embeddingJobs, embeddingStore: retrieval.embeddingStore,
      embeddingProvider, model, logger: workerLogger,
      onJobClaimed: (job) => syncEmbeddingProgress(projectId, trackedProgress, workerLogger, job),
      // Updates progress and logs completion metrics after each symbol embedding job settles.
      // Business purpose: provides real-time vectorization progress for the project's background embedding queue.
      // Technical description: refreshes `trackedProgress.embedding` and emits an `embedding_worker.completed` log entry.
      onJobSettled(job, outcome = {}) {
        syncEmbeddingProgress(projectId, trackedProgress, workerLogger, job, outcome);
        if (closed || outcome?.status !== "completed" || !database) return;
        const counts = embeddingJobs.counts();
        const queued = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
        const vectors = Number(database.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0]?.count ?? 0);
        logger.info(`Embedding job completed (${counts.completed ?? 0} done, ${queued} queued, ${vectors} vectors).`, {
          event_name: "embedding_worker.completed", status: "success", project_id: projectId,
          payload: { job_id: job.job_id, symbol_id: job.symbol_id, model, counts, vectors, project_id: projectId }
        });
      }
    });
    watch = await startProjectWatch({
      projectRoot, projectId, database, databaseExisted, deferReadiness: true,
      internalBus: bus, reconcile: true, logger, chokidarOptions, progress: trackedProgress,
      normalizeComments, rejectOnViolation, fallbackOnViolation,
      indexOptions: {
        embeddingJobs, embeddingModel: model,
        // Wakes the embedding worker as soon as a symbol purpose summary is extracted during indexing.
        // Business purpose: overlaps background vector generation with ongoing file indexing.
        // Technical description: synchronizes embedding counts and calls `worker.notify()`.
        onSummaryQueued() { syncEmbeddingProgress(projectId, trackedProgress, workerLogger); worker.notify(); }
      }
    });
    trackedProgress.stage("embedding");
    await new Promise((resolve) => setImmediate(resolve));
    const startup = prepareEmbeddingQueue({ database, embeddingStore: retrieval.embeddingStore, jobs: embeddingJobs, model });
    if (startup?.recovered > 0) {
      logger.info(`Recovered ${startup.recovered} interrupted embedding job(s).`, {
        event_name: "embedding_worker.recovered", project_id: projectId,
        payload: { count: startup.recovered, model, project_id: projectId }
      });
    }
    syncEmbeddingProgress(projectId, trackedProgress, workerLogger);
    if (awaitInitialEmbeddings) {
      while (!closed && !embeddingError && await worker.runOnce()) syncEmbeddingProgress(projectId, trackedProgress, workerLogger);
      syncEmbeddingProgress(projectId, trackedProgress, workerLogger);
    }
    workerTask = worker.start({ pollMs: embeddingPollMs }).catch((error) => {
      embeddingError = error.message;
      trackedProgress.embedding({ projectId, status: "failed", error: error.message });
      logger.error("Project embedding worker stopped.", { projectId, error });
    });
    worker.notify();
    trackedProgress.stage("startup/readiness");
    trackedProgress.reconcile(database);
    postToParent("ready", { snapshot: trackedProgress.finish() });
  } catch (error) {
    const failedSnapshot = trackedProgress.fail(error);
    try { await shutdownWorker(); } catch (cleanupError) { logger.error("Worker rollback failed.", { error: cleanupError }); }
    postToParent("failed", {
      snapshot: failedSnapshot,
      error: { message: error.message, code: error.code, stage: error.stage, rolledBack: error.rolledBack }
    });
  }
}

parentPort?.on("message", async (message) => {
  if (message?.type !== "stop") return;
  try { await shutdownWorker(); postToParent("stopped", { ok: true }); }
  catch (error) { postToParent("stopped", { ok: false, error: { message: error.message, code: error.code } }); }
});

await runIndexingWorker();
