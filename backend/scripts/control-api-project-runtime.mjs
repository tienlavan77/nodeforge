// Manages in-process Watcher and Embedding Workers for the Control API and coordinates catalog admission.
import { realpath } from "node:fs/promises";
import { createFilesystemWatcher, DEFAULT_WATCHER_IGNORE } from "../src/infrastructure/filesystem/watcher.js";
import { createDebouncedWatcher } from "../src/modules/watcher/debounced-watcher.js";
import { createIncrementalIndexer } from "../src/modules/index/incremental-indexer.js";
import { createEmbeddingJobStore } from "../src/modules/index/embedding-job-store.js";
import { createEmbeddingWorker } from "../src/modules/index/embedding-worker.js";
import { createRetrievalDependencies } from "../src/modules/index/retrieval-dependencies.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createWatcherCacheEvents } from "../src/modules/context/watcher-cache-events.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { startProjectRuntime } from "../src/modules/projects/project-runtime.js";

// Starts separated Watcher Worker and Embedding Worker inside the Control API process over shared storage and logging.
export function startControlApiWorkers({
  projectRoot,
  projectId,
  indexDb,
  runtimeLogger,
  logEvent,
  codeCache,
  subscriptions,
  chokidarOptions,
  watcherFactory = createFilesystemWatcher,
  embeddingProvider,
  ollamaConfig,
  pollMs = 1000,
  runVerification = true,
  debounceMs,
  renameWindowMs
} = {}) {
  const logger = runtimeLogger ?? createRuntimeLogger({ logEvent, source: "project-watcher" });
  const retrieval = createRetrievalDependencies({ database: indexDb, ollamaConfig });
  const resolvedProvider = embeddingProvider ?? retrieval.embeddingProvider;
  const embeddingModel = retrieval.ollamaConfig.model;
  let closed = false;
  let embeddingWorker;
  const embeddingJobs = createEmbeddingJobStore({
    database: indexDb,
    // Wakes the in-process Embedding Worker immediately when an embedding job is enqueued.
    onEnqueue() {
      embeddingWorker?.notify?.();
    }
  });
  embeddingWorker = createEmbeddingWorker({
    database: indexDb,
    jobs: embeddingJobs,
    embeddingStore: retrieval.embeddingStore,
    embeddingProvider: resolvedProvider,
    model: embeddingModel,
    logger: {
      // Forwards transient Ollama or embedding job failures to the Control API runtime logger.
      warning(message, detail = {}) {
        logger.error(message, {
          event_name: "embedding_worker.failed",
          payload: { error: detail.error ?? message }
        });
      }
    },
    // Logs completed embedding jobs with queue and vector counts for terminal progress tracking.
    onJobSettled(job, { status } = {}) {
      if (closed || status !== "completed") return;
      const counts = embeddingJobs.counts();
      const queued = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
      const vectors = Number(indexDb.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0]?.count ?? 0);
      logger.info(`Embedding job completed (${counts.completed ?? 0} done, ${queued} queued, ${vectors} vectors).`, {
        event_name: "embedding_worker.completed",
        status: "success",
        payload: { job_id: job.job_id, symbol_id: job.symbol_id, model: embeddingModel, counts, vectors }
      });
    }
  });
  const recoveredEmbeddingJobs = embeddingJobs.recoverProcessing();
  if (recoveredEmbeddingJobs > 0) {
    logger.info(`Recovered ${recoveredEmbeddingJobs} interrupted embedding job(s).`, {
      event_name: "embedding_worker.recovered",
      payload: { count: recoveredEmbeddingJobs, model: embeddingModel }
    });
  }
  const rawWatcher = watcherFactory({
    root: projectRoot,
    ignore: DEFAULT_WATCHER_IGNORE,
    chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 250, ...chokidarOptions }
  });
  const watcher = createDebouncedWatcher({
    rawWatcher,
    projectId,
    root: projectRoot,
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(renameWindowMs !== undefined ? { renameWindowMs } : {})
  });
  watcher.on("watcher.error", (error) => {
    logger.error("Project watcher reported an event error.", {
      event_name: "watcher.failed",
      payload: { error: error.message, code: error.code ?? null }
    });
  });
  const indexer = createIncrementalIndexer({
    database: indexDb,
    projectRoot,
    embeddingJobs,
    embeddingModel,
    // Signals the Embedding Worker immediately after the Watcher Worker extracts and queues a symbol summary.
    onSummaryQueued() {
      embeddingWorker.notify();
    }
  });
  const workerTask = embeddingWorker.start({ pollMs }).catch((error) => {
    logger.error("Embedding worker stopped.", {
      event_name: "embedding_worker.failed",
      payload: { error: error.message }
    });
  });
  const verification = runVerification ? createVerificationOrchestrator({ projectRoot, projectId }) : null;
  const onWatcherCacheEvent = codeCache ? createWatcherCacheEvents({ projectId, codeCache, logger: logger.emit }) : null;
  const pendingTasks = new Set();
  let closing;

  // Publishes indexed file changes to the in-process project stream and code cache without external HTTP calls.
  function publishStreamEvent(event, indexed) {
    if (closed) return;
    try {
      const indexedFile = indexed && event.type !== "watcher.file_deleted"
        ? indexDb.all("SELECT sha256 FROM files WHERE path = ? LIMIT 1", [event.payload?.path])[0]
        : null;
      const envelope = {
        ...event,
        event_type: event.type,
        source: "watcher",
        metadata: { source: "watcher", project_id: projectId },
        payload: { ...event.payload, ...(indexedFile?.sha256 ? { sha256: indexedFile.sha256 } : {}) },
        indexed: Boolean(indexed),
        project_id: projectId
      };
      if (onWatcherCacheEvent && String(envelope.type ?? "").startsWith("watcher.file_")) {
        void Promise.resolve(onWatcherCacheEvent(envelope)).catch((error) => {
          logger.info(`Watcher cache update failed: ${error.message}`);
        });
      }
      subscriptions?.publish?.(envelope);
    } catch (error) {
      logger.info(`Stream publish unavailable: ${error.message}`);
    }
  }

  logger.info("Project filesystem watcher ready (polling).", { event_name: "watcher.ready" });
  logger.info("Watcher configuration loaded.", {
    event_name: "watcher.config",
    payload: { project_root: projectRoot, index_database: indexDb.databasePath }
  });

  watcher.on("event", (event) => {
    if (closed) return;
    logger.info(`Watcher event ${event.type}.`, {
      event_name: "watcher.event",
      payload: { type: event.type, path: event.payload?.path ?? null, event_id: event.event_id }
    });
    const task = indexer.handle(event)
      .then((indexed) => {
        if (closed) return null;
        logger.info(indexed ? "Indexer updated file." : "Indexer skipped file.", {
          event_name: "watcher.indexed",
          status: indexed ? "success" : "info",
          payload: { path: event.payload?.path ?? null, event_id: event.event_id }
        });
        publishStreamEvent(event, indexed);
        return indexed && verification ? verification.run({
          schema_version: "1.0",
          commit_id: event.event_id,
          levels: ["focused"],
          checks: [{ type: "test", command: "node -e \"process.exit(0)\"", timeout_ms: 1000 }]
        }) : null;
      })
      .then((result) => {
        if (!result || closed) return;
        logger.info(`Watcher verification ${result.status}.`, {
          event_name: "watcher.verification",
          status: result.status === "failed" ? "failed" : "success",
          payload: { path: event.payload?.path ?? null, run_id: result.run_id ?? null, event_id: event.event_id }
        });
      })
      .catch((error) => {
        if (closed) return;
        logger.error("Watcher verification failed.", {
          event_name: "watcher.verification_failed",
          payload: { error: error.message, event_id: event.event_id }
        });
      })
      .finally(() => pendingTasks.delete(task));
    pendingTasks.add(task);
  });

  // Stops the Watcher Worker and Embedding Worker cleanly before the shared SQLite database closes.
  function stop() {
    closed = true;
    closing ??= (async () => {
      const errors = [];
      try { await watcher.close?.(); } catch (error) { errors.push(error); }
      await Promise.allSettled([...pendingTasks]);
      const runningWorker = embeddingWorker.stop();
      try { await resolvedProvider?.close?.(); } catch (error) { errors.push(error); }
      try { await (workerTask ?? runningWorker); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Control API project workers cleanup failed.");
    })();
    return closing;
  }

  return Object.freeze({
    projectRoot,
    projectId,
    watch: watcher,
    worker: embeddingWorker,
    embeddingJobs,
    // Reports whether the in-process Watcher and Embedding Workers are still active.
    status() { return { projectId, projectRoot, closed }; },
    stop,
    close: stop
  });
}

// Reuses the Control API's in-process default project runtime once; later admissions start independently owned runtimes.
export function createControlApiProjectRuntime({ projectRoot, projectId, startRuntime = startProjectRuntime, getDefaultWorkers } = {}) {
  const canonicalRoot = realpath(projectRoot);
  let available = true;

  // Binds catalog membership to the existing Control API application only when root and persisted identity both match.
  return async function start(input) {
    if (!available || input.projectRoot !== await canonicalRoot) return startRuntime(input);
    if (input.projectId !== projectId) throw new Error("Catalog and Control API project identity differ.");
    available = false;
    let closed = false;
    return Object.freeze({
      projectRoot: input.projectRoot,
      projectId,
      get watch() { return getDefaultWorkers?.()?.watch; },
      get worker() { return getDefaultWorkers?.()?.worker; },
      // Exposes admission availability while the application registry owns the database and worker resources.
      status() { return { projectId, projectRoot: input.projectRoot, closed: closed || Boolean(getDefaultWorkers?.()?.status?.().closed) }; },
      // Retires this binding; application disposal releases the shared storage and workers without duplicate cleanup.
      close() { closed = true; }
    });
  };
}
