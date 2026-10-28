// Composes an isolated index, watcher, embedding worker, and activity stream for one project.
import { EventEmitter } from "node:events";
import { createIndexProgress } from "../index/index-progress.js";
import { openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createIdeasStore } from "./ideas-store.js";
import { startProjectWatch } from "../watcher/watch-project.js";
import { createEmbeddingJobStore } from "../index/embedding-job-store.js";
import { purposeSummaryInput } from "../index/purpose-summary-input.js";
import { createEmbeddingWorker } from "../index/embedding-worker.js";
import { createRetrievalDependencies } from "../index/retrieval-dependencies.js";
import { createSubscriptionRegistry } from "../events/subscription-registry.js";
import { createProjectStream } from "../../transport/sse/project-stream.js";

// Starts every per-project service without introducing an HTTP or CLI management contract.
export async function startProjectRuntime({ projectRoot, projectId, logger = console, embeddingProvider, ollamaConfig, chokidarOptions, watcherFactory, onProgress = () => {}, progress = createIndexProgress({ onProgress }), normalizeComments = true, coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false, onRuntimeCreated = null } = {}) {
  const bus = new EventEmitter();
  const subscriptions = createSubscriptionRegistry({ logger });
  const connections = new Set();
  let database;
  let controlDb;
  let ideas;
  let retrieval;
  let worker;
  let embeddingJobs;
  let workerTask;
  let watch;
  let closing;
  let closed = false;
  let embeddingError = null;
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
  const stream = createProjectStream({
    projectId,
    indexDb: { all: (...args) => database ? database.all(...args) : [] },
    runtimeSnapshot: () => {
      const snap = trackedProgress.snapshot();
      return { readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running", stage: snap.stage, status: snap.status, progress: snap };
    },
    subscriptions,
    eventBus: bus
  });
  // Synchronizes durable embedding job counts into the index progress collector.
  function syncEmbeddingProgress() {
    const counts = closed || !embeddingJobs ? null : embeddingJobs.counts();
    if (counts) {
      trackedProgress.embedding({
        status: embeddingError ? "failed" : counts.pending || counts.processing || counts.retry_wait ? "running" : "succeeded",
        ...(embeddingError ? { error: String(embeddingError) } : {}),
        pending: (counts.pending ?? 0) + (counts.retry_wait ?? 0),
        processing: counts.processing ?? 0,
        succeeded: counts.completed ?? 0,
        failed: counts.failed ?? 0
      });
    }
  }
  // Exposes affected-worker diagnostics and Option B readiness without changing public stream schemas.
  function status() {
    syncEmbeddingProgress();
    const snap = trackedProgress.snapshot();
    return {
      projectId, projectRoot, embeddingError, closed,
      readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running",
      progress: snap
    };
  }
  const workerLogger = {
    // Reports Ollama failure for this project while its watcher and other projects keep running.
    warning(message, detail) {
      embeddingError = detail.error;
      trackedProgress.embedding({ status: "failed", error: String(detail.error) });
      logger.warn?.(message, { ...detail, projectId });
      bus.emit("embedding.failed", { projectId, error: detail.error });
    }
  };
  try {
    onRuntimeCreated?.(Object.freeze({ projectRoot, projectId, bus, connect, close, status }));
    controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    ideas = createIdeasStore({ controlDb, projectId });
    watch = await startProjectWatch({
      projectRoot, projectId, internalBus: bus, reconcile: true, logger, chokidarOptions, watcherFactory, progress: trackedProgress,
      normalizeComments, coderNormalizer, rejectOnViolation, fallbackOnViolation,
      // Shares one project database between indexing, semantic retrieval, and its durable worker.
      prepareDatabase(indexDb) {
        database = indexDb;
        retrieval = createRetrievalDependencies({ database, ollamaConfig });
        embeddingProvider ??= retrieval.embeddingProvider;
        const jobs = createEmbeddingJobStore({ database });
        embeddingJobs = jobs;
        jobs.recoverProcessing();
        worker = createEmbeddingWorker({ database, jobs, embeddingStore: retrieval.embeddingStore, embeddingProvider, model: retrieval.ollamaConfig.model, logger: workerLogger });
        return {
          indexOptions: { embeddingJobs: jobs, embeddingModel: retrieval.ollamaConfig.model },
          // Drains initial symbol embeddings during the embedding stage before marking the project ready.
          async runInitialEmbeddings() {
            await new Promise((resolve) => setImmediate(resolve));
            queueMissingEmbeddings();
            syncEmbeddingProgress();
            while (!closed && !embeddingError && await worker.runOnce()) {
              syncEmbeddingProgress();
            }
            syncEmbeddingProgress();
          },
          close: stopEmbedding
        };
      }
    });
    workerTask = worker.start();
    workerTask = workerTask.catch((error) => {
      embeddingError = error.message;
      trackedProgress.embedding({ status: "failed", error: error.message });
      logger.error?.("Project embedding worker stopped.", { projectId, error });
    });
    return Object.freeze({ projectRoot, projectId, bus, database, controlDb, ideas, worker, connect, close,
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
    const model = retrieval.ollamaConfig.model;
    for (const symbol of database.all(`SELECT s.symbol_id, s.summary,
      e.embedding_model, e.content_checksum FROM symbols s
      LEFT JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id`)) {
      const input = purposeSummaryInput(symbol.summary);
      if (!input) continue;
      const contentChecksum = input.checksum;
      if (symbol.embedding_model !== model || symbol.content_checksum !== contentChecksum) {
        embeddingJobs.enqueue({ symbolId: symbol.symbol_id, contentChecksum, model });
      }
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
    worker?.stop();
    try { await embeddingProvider?.close?.(); } finally { await workerTask; }
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
    for (const connection of [...connections]) {
      try { connection.close(); } catch (error) { errors.push(error); }
    }
    try { await (watch ? watch.close() : stopEmbedding()); } catch (error) { errors.push(error); }
    try { await controlDb?.close(); } catch (error) { errors.push(error); }
    bus.removeAllListeners();
    if (errors.length) throw new AggregateError(errors, "Project runtime cleanup failed.");
  }
}
