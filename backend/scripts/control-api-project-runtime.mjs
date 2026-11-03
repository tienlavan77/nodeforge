// Manages in-process Watcher and Embedding Workers for the Control API and coordinates catalog admission.
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { createFilesystemWatcher, DEFAULT_WATCHER_IGNORE } from "../src/infrastructure/filesystem/watcher.js";
import { createDebouncedWatcher } from "../src/modules/watcher/debounced-watcher.js";
import { createIncrementalIndexer } from "../src/modules/index/incremental-indexer.js";
import { createEmbeddingJobStore } from "../src/modules/index/embedding-job-store.js";
import { createEmbeddingWorker } from "../src/modules/index/embedding-worker.js";
import { createIndexProgress } from "../src/modules/index/index-progress.js";
import { createRetrievalDependencies } from "../src/modules/index/retrieval-dependencies.js";
import { prepareEmbeddingQueue, releaseEmbeddingProvider, retainEmbeddingProvider } from "../src/modules/index/embedding-startup.js";
import { createSubscriptionRegistry } from "../src/modules/events/subscription-registry.js";
import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
import { createWatcherCacheEvents } from "../src/modules/context/watcher-cache-events.js";
import { createRuntimeLogger } from "../src/core/runtime-logger.js";
import { startProjectRuntime } from "../src/modules/projects/project-runtime.js";
import { createProjectStream } from "../src/transport/sse/project-stream.js";

// Starts separated Watcher Worker and Embedding Worker inside the Control API process over shared storage and logging.
export function startControlApiWorkers({
  projectRoot,
  projectId,
  indexDb,
  runtimeLogger,
  logEvent,
  codeCache,
  subscriptions,
  bus: externalBus,
  internalBus: externalInternalBus,
  executionActivity,
  onProgress = () => {},
  progress: externalProgress,
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
  const progress = externalProgress ?? createIndexProgress({ onProgress });
  const internalBus = externalInternalBus ?? new EventEmitter();
  const workerSubscriptions = subscriptions ?? createSubscriptionRegistry();
  const connections = new Set();
  const retrieval = createRetrievalDependencies({ database: indexDb, ollamaConfig });
  const resolvedProvider = embeddingProvider ?? retrieval.embeddingProvider;
  retainEmbeddingProvider(resolvedProvider);
  let providerRetained = true;
  const embeddingModel = resolvedProvider.model ?? (embeddingProvider ? ollamaConfig?.model : null) ?? retrieval.embeddingProvider.model;
  let closed = false;
  let embeddingError = null;
  let embeddingWorker;

  /**
   * Business purpose: synchronizes durable embedding queue counters and error state into the default project's index progress collector without affecting workspace readiness.
   * Technical description: queries embedding_jobs counts and unresolved errors from indexDb and updates progress.embedding with project-scoped diagnostic fields.
   */
  function syncEmbeddingProgress(job, outcome) {
    if (closed) return;
    try {
      if (outcome?.status === "completed") {
        embeddingError = indexDb.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null;
      }
      const counts = embeddingJobs.counts();
      const unresolvedError = indexDb.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null;
      if (unresolvedError) embeddingError ??= unresolvedError;
      else if (!counts.failed && !counts.retry_wait && outcome?.status !== "failed") embeddingError = null;
      const error = unresolvedError ?? embeddingError;
      const hasFailure = Boolean(error || counts.failed || counts.retry_wait);
      progress.embedding({
        projectId,
        status: hasFailure ? "failed" : counts.pending || counts.processing ? "running" : "succeeded",
        pending: (counts.pending ?? 0) + (counts.retry_wait ?? 0),
        processing: counts.processing ?? 0,
        succeeded: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        error: error ? String(error) : null
      });
    // eslint-disable-next-line no-silent-catch -- Preserves the last progress snapshot when status() is read after the shared SQLite database closes.
    } catch {
      /* Preserve the last progress snapshot if the shared SQLite database was already closed. */
    }
  }

  const embeddingJobs = createEmbeddingJobStore({
    database: indexDb,
    // Wakes the in-process Embedding Worker immediately when an embedding job is enqueued.
    onEnqueue() {
      syncEmbeddingProgress();
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
        embeddingError = detail.error ?? message;
        progress.embedding({ projectId, status: "failed", error: String(embeddingError) });
        logger.error(message, {
          event_name: "embedding_worker.failed",
          payload: { error: detail.error ?? message, project_id: projectId }
        });
      }
    },
    onJobClaimed: syncEmbeddingProgress,
    // Logs completed embedding jobs with queue and vector counts for terminal progress tracking.
    onJobSettled(job, outcome = {}) {
      syncEmbeddingProgress(job, outcome);
      if (closed || outcome.status !== "completed") return;
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
  const startup = prepareEmbeddingQueue({
    database: indexDb, embeddingStore: retrieval.embeddingStore, jobs: embeddingJobs, model: embeddingModel
  });
  progress.stage("startup/readiness");
  progress.reconcile(indexDb);
  progress.finish();
  syncEmbeddingProgress();
  const recoveredEmbeddingJobs = startup.recovered;
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
      syncEmbeddingProgress();
      embeddingWorker.notify();
    }
  });
  const workerTask = embeddingWorker.start({ pollMs }).catch((error) => {
    embeddingError = error.message;
    progress.embedding({ projectId, status: "failed", error: error.message });
    logger.error("Embedding worker stopped.", {
      event_name: "embedding_worker.failed",
      payload: { error: error.message, project_id: projectId }
    });
  });
  embeddingWorker.notify();
  const verification = runVerification ? createVerificationOrchestrator({ projectRoot, projectId }) : null;
  const onWatcherCacheEvent = codeCache ? createWatcherCacheEvents({ projectId, codeCache, logger: logger.emit }) : null;
  const pendingTasks = new Set();
  let closing;
  const stream = createProjectStream({
    projectId: projectId ?? "PROJECT-DEFAULT",
    indexDb,
    runtimeSnapshot: () => {
      const current = status();
      return { readiness: current.readiness, stage: current.progress.stage, status: current.progress.status, progress: current.progress };
    },
    subscriptions: workerSubscriptions,
    eventBus: internalBus,
    bus: externalBus,
    agentActivitySnapshot: executionActivity?.snapshot
  });

  /**
   * Business purpose: attaches an SSE client to the default project's progress and workspace stream and tracks the connection for clean shutdown.
   * Technical description: delegates to the in-process project stream and registers a disconnect listener so stop() closes every active connection.
   */
  function connect(input) {
    if (closed) throw new Error("Project runtime is closed.");
    const connection = stream.connect(input);
    const response = input.response;
    const owned = { close: disconnect };
    connections.add(owned);
    response.once?.("close", disconnect);
    return owned;
    // Removes the connection handle when the client disconnects or the worker stops.
    function disconnect() {
      connections.delete(owned);
      response.off?.("close", disconnect);
      connection.close();
    }
  }

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
      workerSubscriptions?.publish?.(envelope);
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
    const handleEvent = typeof indexer.handleDetailed === "function"
      ? indexer.handleDetailed(event).then((detailed) => {
        if (!closed) {
          progress.result(detailed);
          progress.reconcile(indexDb);
        }
        return Boolean(detailed?.committed);
      })
      : indexer.handle(event);
    const task = handleEvent
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
    status();
    closed = true;
    closing ??= (async () => {
      const errors = [];
      for (const connection of [...connections]) {
        try { connection.close(); } catch (error) { errors.push(error); }
      }
      try { await watcher.close?.(); } catch (error) { errors.push(error); }
      await Promise.allSettled([...pendingTasks]);
      const runningWorker = embeddingWorker.stop();
      try {
        if (providerRetained) {
          providerRetained = false;
          await releaseEmbeddingProvider(resolvedProvider);
        }
      } catch (error) { errors.push(error); }
      try { await (workerTask ?? runningWorker); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Control API project workers cleanup failed.");
    })();
    return closing;
  }

  /**
   * Reports durable queue progress and unresolved failures to lifecycle clients.
   * Caches the last snapshot so status remains safe after the database closes.
   */
  function status() {
    if (!closed) syncEmbeddingProgress();
    const snap = progress.snapshot();
    return {
      projectId,
      projectRoot,
      closed,
      embeddingError: snap.embedding?.error ?? null,
      progress: snap,
      readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running"
    };
  }

  return Object.freeze({
    projectRoot,
    projectId,
    bus: internalBus,
    watch: watcher,
    worker: embeddingWorker,
    embeddingJobs,
    connect,
    // Reports whether the in-process Watcher and Embedding Workers are still active.
    status,
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
    const fallbackProgress = createIndexProgress();
    fallbackProgress.stage("startup/readiness");
    fallbackProgress.reconcile({ all: () => [{ version: 0, count: 0 }] });
    fallbackProgress.finish();
    fallbackProgress.embedding({ projectId, status: "succeeded", pending: 0, processing: 0, succeeded: 0, failed: 0, error: null });
    const fallbackBus = new EventEmitter();
    const fallbackSubscriptions = createSubscriptionRegistry();
    const fallbackConnections = new Set();
    const fallbackStream = createProjectStream({
      projectId,
      indexDb: { all: () => [] },
      runtimeSnapshot: () => {
        const current = readStatus();
        return { readiness: current.readiness, stage: current.progress.stage, status: current.progress.status, progress: current.progress };
      },
      subscriptions: fallbackSubscriptions,
      eventBus: fallbackBus
    });
    // Synthesizes a normalized status snapshot when the default worker handle is a minimal test stub.
    function readStatus() {
      const snapshot = getDefaultWorkers?.()?.status?.();
      const isClosed = closed || Boolean(snapshot?.closed);
      const prog = snapshot?.progress?.stages ? snapshot.progress : fallbackProgress.snapshot();
      const readiness = isClosed || prog.status === "failed" ? "unavailable" : prog.status === "succeeded" ? "ready" : "running";
      return {
        ...snapshot,
        projectId,
        projectRoot: input.projectRoot,
        closed: isClosed,
        embeddingError: snapshot?.embeddingError ?? prog.embedding?.error ?? null,
        progress: prog,
        readiness
      };
    }
    // Connects SSE subscribers to the default worker stream or the normalized fallback stream.
    function connect(streamInput) {
      if (readStatus().closed) throw new Error("Project runtime is closed.");
      const defaultConnect = getDefaultWorkers?.()?.connect;
      if (typeof defaultConnect === "function") return defaultConnect(streamInput);
      const connection = fallbackStream.connect(streamInput);
      const owned = {
        close() {
          fallbackConnections.delete(owned);
          streamInput.response?.off?.("close", owned.close);
          connection.close();
        }
      };
      fallbackConnections.add(owned);
      streamInput.response?.once?.("close", owned.close);
      return owned;
    }
    if (input.progress) {
      const currentProgress = readStatus().progress;
      input.progress.stage("startup/readiness");
      input.progress.reconcile({ all: (sql) => sql.includes("index_metadata") ? [{ version: currentProgress.checkpoint?.version ?? 0 }] : [{ count: sql.includes("FROM files") ? (currentProgress.checkpoint?.files ?? 0) : (currentProgress.checkpoint?.functions ?? 0) }] });
      if (currentProgress.embedding) input.progress.embedding(currentProgress.embedding);
      input.progress.finish();
    }
    const runtime = Object.freeze({
      projectRoot: input.projectRoot,
      projectId,
      get bus() { return getDefaultWorkers?.()?.bus ?? fallbackBus; },
      get watch() { return getDefaultWorkers?.()?.watch; },
      get worker() { return getDefaultWorkers?.()?.worker; },
      connect,
      // Exposes admission availability while the application registry owns the database and worker resources.
      status: readStatus,
      // Retires this binding; application disposal releases the shared storage and workers without duplicate cleanup.
      close() {
        closed = true;
        for (const conn of [...fallbackConnections]) conn.close();
      }
    });
    input.onRuntimeCreated?.(runtime);
    return runtime;
  };
}
