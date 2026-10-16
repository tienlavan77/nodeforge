// Composes an isolated index, watcher, embedding worker, and activity stream for one project.
import { EventEmitter } from "node:events";
import { startProjectWatch } from "../watcher/watch-project.js";
import { createEmbeddingJobStore } from "../index/embedding-job-store.js";
import { createEmbeddingWorker } from "../index/embedding-worker.js";
import { createRetrievalDependencies } from "../index/retrieval-dependencies.js";
import { createSubscriptionRegistry } from "../events/subscription-registry.js";
import { createProjectStream } from "../../transport/sse/project-stream.js";

// Starts every per-project service without introducing an HTTP or CLI management contract.
export async function startProjectRuntime({ projectRoot, projectId, logger = console, embeddingProvider, ollamaConfig, chokidarOptions, watcherFactory } = {}) {
  const bus = new EventEmitter();
  const subscriptions = createSubscriptionRegistry({ logger });
  const connections = new Set();
  let database;
  let retrieval;
  let worker;
  let workerTask;
  let watch;
  let stream;
  let closing;
  let closed = false;
  let embeddingError = null;
  const workerLogger = {
    // Reports Ollama failure for this project while its watcher and other projects keep running.
    warning(message, detail) {
      embeddingError = detail.error;
      logger.warn?.(message, { ...detail, projectId });
      bus.emit("embedding.failed", { projectId, error: detail.error });
    }
  };
  try {
    watch = await startProjectWatch({
      projectRoot, projectId, internalBus: bus, reconcile: true, logger, chokidarOptions, watcherFactory,
      // Shares one project database between indexing, semantic retrieval, and its durable worker.
      prepareDatabase(indexDb) {
        database = indexDb;
        retrieval = createRetrievalDependencies({ database, ollamaConfig });
        embeddingProvider ??= retrieval.embeddingProvider;
        const jobs = createEmbeddingJobStore({ database });
        jobs.recoverProcessing();
        worker = createEmbeddingWorker({ database, jobs, embeddingStore: retrieval.embeddingStore, embeddingProvider, model: retrieval.ollamaConfig.model, logger: workerLogger });
        return { indexOptions: { embeddingJobs: jobs, embeddingModel: retrieval.ollamaConfig.model }, close: stopEmbedding };
      }
    });
    stream = createProjectStream({ projectId, indexDb: database, subscriptions, eventBus: bus });
    workerTask = worker.start();
    workerTask = workerTask.catch((error) => {
      embeddingError = error.message;
      logger.error?.("Project embedding worker stopped.", { projectId, error });
    });
    return Object.freeze({ projectRoot, projectId, bus, database, worker, connect, close,
      search: retrieval.search, embeddingStore: retrieval.embeddingStore, embeddingProvider,
      // Exposes affected-worker diagnostics without changing public stream schemas.
      status() { return { projectId, projectRoot, embeddingError, closed }; }
    });
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Project runtime startup and rollback failed.");
    }
    throw error;
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
    bus.removeAllListeners();
    if (errors.length) throw new AggregateError(errors, "Project runtime cleanup failed.");
  }
}
