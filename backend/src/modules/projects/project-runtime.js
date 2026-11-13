// Composes an isolated index, watcher, embedding worker, and activity stream for one project.
import { EventEmitter } from "node:events";
import { createIndexProgress } from "../index/index-progress.js";
import { ensureRuntimeDir, openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createNotebookStore } from "./notebook-store.js";
import { INDEX_RUNTIME_DIR, indexDatabaseExists, startProjectWatch } from "../watcher/watch-project.js";
import { createEmbeddingJobStore } from "../index/embedding-job-store.js";
import { prepareEmbeddingQueue, releaseEmbeddingProvider, retainEmbeddingProvider } from "../index/embedding-startup.js";
import { createEmbeddingWorker } from "../index/embedding-worker.js";
import { createRetrievalDependencies } from "../index/retrieval-dependencies.js";
import { createSubscriptionRegistry } from "../events/subscription-registry.js";
import { createProjectStream } from "../../transport/sse/project-stream.js";
import { createApplicationBridge } from "./project-runtime-bridge.js";
import { startProjectWorkerRuntime } from "./project-worker-runtime.js";

// Starts every per-project service without introducing an HTTP or CLI management contract.
export async function startProjectRuntime({ projectRoot, projectId, logger = console, embeddingProvider, ollamaConfig, chokidarOptions, watcherFactory, onProgress = () => {}, progress = createIndexProgress({ onProgress }), normalizeComments = true, coderNormalizer = null, rejectOnViolation = false, fallbackOnViolation = false, onRuntimeCreated = null, awaitInitialEmbeddings = false, embeddingPollMs = 1000, useWorkerThread = false, sharedStreamState = null } = {}) {
  if (useWorkerThread && !watcherFactory && !coderNormalizer && !embeddingProvider) {
    return startProjectWorkerRuntime({
      projectRoot, projectId, logger, ollamaConfig, chokidarOptions,
      onProgress, progress, normalizeComments, rejectOnViolation, fallbackOnViolation,
      onRuntimeCreated, awaitInitialEmbeddings, embeddingPollMs, sharedStreamState
    });
  }
  const bus = sharedStreamState?.bus ?? new EventEmitter();
  const subscriptions = sharedStreamState?.subscriptions ?? createSubscriptionRegistry({ logger });
  const connections = sharedStreamState?.connections ?? new Set();
  const conversationListeners = new Set();
  let database, controlDb, notebook, retrieval, worker, embeddingJobs, workerTask, watch, closing;
  let closed = false, embeddingError = null, providerRetained = false;
  const baseProgress = progress;
  const trackedProgress = Object.freeze({
    ...baseProgress,
    // Broadcasts real-time stage transitions onto the project stream while indexing is running.
    stage(value) {
      const snap = baseProgress.stage(value);
      bus.emit("agent.activity", {
        event_type: "agent.activity", project_id: projectId, timestamp: new Date().toISOString(),
        payload: { agent_id: "coder", activity_type: "progress", status: "working", summary: `Stage ${value}: running` }
      });
      return snap;
    },
    // Broadcasts terminal indexing readiness onto the project stream when all stages settle.
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
  const bridge = createApplicationBridge({ projectId, bus, subscriptions, conversationListeners, isClosed: () => closed });
  const { bindApplication } = bridge;
  const conversationBusProxy = {
    // Subscribes an active SSE connection listener to the project-bound communication bus.
    subscribeAll(listener) { conversationListeners.add(listener); bridge.getBoundServices()?.bus?.subscribeAll?.(listener); },
    // Unsubscribes an SSE connection listener from the project-bound communication bus on disconnect.
    unsubscribeAll(listener) { conversationListeners.delete(listener); bridge.getBoundServices()?.bus?.unsubscribeAll?.(listener); }
  };
  const stream = createProjectStream({
    projectId, indexDb: { all: (...args) => database ? database.all(...args) : [] },
    runtimeSnapshot: () => {
      syncEmbeddingProgress();
      const snap = trackedProgress.snapshot();
      return { readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running", stage: snap.stage, status: snap.status, progress: snap };
    },
    subscriptions, eventBus: bus, bus: conversationBusProxy,
    agentActivitySnapshot: (args) => bridge.getBoundServices()?.executionActivity?.snapshot?.(args) ?? []
  });
  // Synchronizes durable embedding job counts into the index progress collector.
  function syncEmbeddingProgress(job, outcome) {
    if (outcome?.status === "completed") workerLogger.clearEmbeddingError();
    const counts = closed || !embeddingJobs ? null : embeddingJobs.counts();
    if (!counts) return;
    const unresolvedError = !closed && database ? database.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null : null;
    if (unresolvedError) embeddingError ??= unresolvedError;
    else if (!counts.failed && !counts.retry_wait && outcome?.status !== "failed") embeddingError = null;
    const hasFailure = Boolean(embeddingError || counts.failed || counts.retry_wait);
    trackedProgress.embedding({
      projectId, status: hasFailure ? "failed" : counts.pending || counts.processing ? "running" : "succeeded",
      error: embeddingError ? String(embeddingError) : null, pending: (counts.pending ?? 0) + (counts.retry_wait ?? 0),
      processing: counts.processing ?? 0, succeeded: counts.completed ?? 0, failed: counts.failed ?? 0
    });
  }
  // Exposes affected-worker diagnostics and Option B readiness without changing public stream schemas.
  function status() {
    syncEmbeddingProgress();
    const snap = trackedProgress.snapshot();
    return { projectId, projectRoot, embeddingError, closed, readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running", progress: snap };
  }
  const workerLogger = {
    // Reports Ollama failure for this project while its watcher and other projects keep running.
    warning(message, detail) {
      embeddingError = detail.error;
      trackedProgress.embedding({ projectId, status: "failed", error: String(detail.error) });
      if (typeof logger.warn === "function") logger.warn(message, { ...detail, projectId });
      else logger.error?.(message, { event_name: "embedding_worker.failed", project_id: projectId, payload: { error: detail.error ?? message, project_id: projectId } });
      bus.emit("embedding.failed", { projectId, error: detail.error });
    },
    // Clears transient Ollama error state after a retry succeeds and no failed or retry_wait jobs remain.
    clearEmbeddingError() {
      const unresolved = !closed && database ? database.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null : null;
      embeddingError = unresolved;
    }
  };
  try {
    onRuntimeCreated?.(Object.freeze({ projectRoot, projectId, bus, connect, bindApplication, close, status }));
    controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    notebook = createNotebookStore({ controlDb, projectId });
    const databaseExisted = await indexDatabaseExists(projectRoot);
    if (!databaseExisted) await ensureRuntimeDir(projectRoot);
    database = await openIndexDatabase(projectRoot, { runtimeDir: INDEX_RUNTIME_DIR });
    retrieval = createRetrievalDependencies({ database, ollamaConfig });
    embeddingProvider ??= retrieval.embeddingProvider;
    retainEmbeddingProvider(embeddingProvider);
    providerRetained = true;
    const model = embeddingProvider.model ?? (ollamaConfig?.model || retrieval.embeddingProvider.model);
    retrieval = { ...retrieval, embeddingModel: model };
    retrieval.embeddingStore.removeOtherModels(model);
    embeddingJobs = createEmbeddingJobStore({
      database,
      // Synchronizes durable embedding queue counters into runtime progress and wakes the idle embedding worker when a symbol summary job is enqueued.
      onEnqueue() {
        syncEmbeddingProgress();
        worker?.notify?.();
      }
    });
    embeddingJobs.removeOtherModels(model);
    embeddingJobs.recoverProcessing();
    worker = createEmbeddingWorker({
      database,
      jobs: embeddingJobs,
      embeddingStore: retrieval.embeddingStore,
      embeddingProvider,
      model,
      logger: workerLogger,
      onJobClaimed: syncEmbeddingProgress,
      // Synchronizes durable embedding progress and emits terminal completion logs with queue and vector counts.
      onJobSettled(job, outcome = {}) {
        syncEmbeddingProgress(job, outcome);
        if (closed || outcome?.status !== "completed" || !database) return;
        const counts = embeddingJobs.counts();
        const queued = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
        const vectors = Number(database.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0]?.count ?? 0);
        logger.info?.(`Embedding job completed (${counts.completed ?? 0} done, ${queued} queued, ${vectors} vectors).`, {
          event_name: "embedding_worker.completed",
          status: "success",
          project_id: projectId,
          payload: { job_id: job.job_id, symbol_id: job.symbol_id, model, counts, vectors, project_id: projectId }
        });
      }
    });
    watch = await startProjectWatch({
      projectRoot, projectId, database, databaseExisted, deferReadiness: true,
      internalBus: bus, reconcile: true, logger, chokidarOptions, watcherFactory, progress: trackedProgress,
      normalizeComments, coderNormalizer, rejectOnViolation, fallbackOnViolation,
      indexOptions: {
        embeddingJobs,
        embeddingModel: model,
        // Triggers an immediate wake signal on the embedding worker and refreshes progress after the watcher worker extracts and queues a symbol summary.
        onSummaryQueued() {
          syncEmbeddingProgress();
          worker.notify();
        }
      }
    });
    trackedProgress.stage("embedding");
    await new Promise((resolve) => setImmediate(resolve));
    queueMissingEmbeddings();
    syncEmbeddingProgress();
    if (awaitInitialEmbeddings) {
      while (!closed && !embeddingError && await worker.runOnce()) {
        syncEmbeddingProgress();
      }
      syncEmbeddingProgress();
    }
    workerTask = worker.start({ pollMs: embeddingPollMs });
    workerTask = workerTask.catch((error) => {
      embeddingError = error.message;
      trackedProgress.embedding({ projectId, status: "failed", error: error.message });
      logger.error?.("Project embedding worker stopped.", { projectId, error });
    });
    worker.notify();
    trackedProgress.stage("startup/readiness");
    trackedProgress.reconcile(database);
    trackedProgress.finish();
    return Object.freeze({ projectRoot, projectId, bus, database, controlDb, notebook, watch, worker, connect, bindApplication, close,
      search: retrieval.search, embeddingStore: retrieval.embeddingStore, embeddingProvider, status
    });
  } catch (error) {
    progress.fail(error);
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Project runtime startup and rollback failed.");
    }
    throw error;
  }



  // Upgrades unchanged legacy indexes and changed embedding models without rebuilding project identity.
  function queueMissingEmbeddings() {
    const startup = prepareEmbeddingQueue({
      database,
      embeddingStore: retrieval.embeddingStore,
      jobs: embeddingJobs,
      model: retrieval.embeddingModel
    });
    if (startup?.recovered > 0) {
      logger.info?.(`Recovered ${startup.recovered} interrupted embedding job(s).`, {
        event_name: "embedding_worker.recovered",
        project_id: projectId,
        payload: { count: startup.recovered, model: retrieval.embeddingModel, project_id: projectId }
      });
    }
  }

  // Owns each SSE connection so project removal clears subscriptions and heartbeat timers.
  function connect(input) {
    if (closed) throw new Error("Project runtime is closed.");
    const connection = stream.connect(input);
    const response = input.response;
    const owned = { close: disconnect };
    connections.add(owned);
    response.once?.("close", disconnect);
    return owned;
    // Releases the stream when the client disconnects or the project is removed.
    function disconnect() {
      connections.delete(owned);
      response.off?.("close", disconnect);
      connection.close();
    }
  }

  // Cancels Ollama requests and awaits the worker before its database can be closed.
  async function stopEmbedding() {
    const runningTask = worker?.stop();
    try {
      if (providerRetained) {
        providerRetained = false;
        await releaseEmbeddingProvider(embeddingProvider);
      }
    } finally {
      await (workerTask ?? runningTask);
    }
  }

  // Makes concurrent and repeated removal share the same complete teardown.
  function close() {
    closed = true;
    closing ??= release();
    return closing;
  }

  // Attempts all project-owned cleanup even if a stream or watcher fails to close.
  async function release() {
    const errors = [];
    try { bridge.unbind(); } catch (error) { errors.push(error); }
    for (const connection of [...connections]) {
      try { connection.close(); } catch (error) { errors.push(error); }
    }
    try { await watch?.close(); } catch (error) { errors.push(error); }
    try { await stopEmbedding(); } catch (error) { errors.push(error); }
    try { await database?.close(); } catch (error) { errors.push(error); }
    try { await controlDb?.close(); } catch (error) { errors.push(error); }
    bus.removeAllListeners();
    if (errors.length) throw new AggregateError(errors, "Project runtime cleanup failed.");
  }
}
