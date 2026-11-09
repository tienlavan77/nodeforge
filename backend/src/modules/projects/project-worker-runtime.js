// Coordinates a project runtime whose comment normalization, code indexing, file watching, and embedding worker run in a background Worker Thread.
// Business purpose: provides the exact same runtime interface (`status`, `connect`, `bindApplication`, `database`, `controlDb`, `notebook`, `search`, `close`) expected by the Control API while offloading all heavy indexing and embedding work from the main event loop.
// Technical description: spawns `project-indexing-worker.js` via `node:worker_threads`, synchronizes worker progress snapshots and bus events into the main-thread SSE stream and progress collector, opens read/write SQLite handles in WAL mode for query access, and tears down both thread and local handles on `close()`.
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { createIndexProgress } from "../index/index-progress.js";
import { ensureRuntimeDir, openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createNotebookStore } from "./notebook-store.js";
import { createApplicationBridge } from "./project-runtime-bridge.js";
import { INDEX_RUNTIME_DIR, indexDatabaseExists } from "../watcher/watch-project.js";
import { createRetrievalDependencies } from "../index/retrieval-dependencies.js";
import { createSubscriptionRegistry } from "../events/subscription-registry.js";
import { createProjectStream } from "../../transport/sse/project-stream.js";

const WORKER_SCRIPT_URL = new URL("./project-indexing-worker.js", import.meta.url);

// Starts a project runtime backed by a dedicated Worker Thread for comment normalization, indexing, watching, and embedding.
// Business purpose: executes all heavy intake and background indexing work off the Control API main thread while keeping SSE streaming and progress reporting responsive.
// Technical description: opens WAL-mode SQLite connections for main-thread queries, spawns `project-indexing-worker.js`, mirrors worker snapshots into `progress`, and resolves once baseline indexing settles.
export async function startProjectWorkerRuntime({
  projectRoot, projectId, logger = console, ollamaConfig, chokidarOptions,
  onProgress = () => {}, progress = createIndexProgress({ onProgress }),
  normalizeComments = true, rejectOnViolation = true, fallbackOnViolation = false,
  onRuntimeCreated = null, awaitInitialEmbeddings = false, embeddingPollMs = 1000,
  sharedStreamState = null
} = {}) {
  const bus = sharedStreamState?.bus ?? new EventEmitter();
  const subscriptions = sharedStreamState?.subscriptions ?? createSubscriptionRegistry({ logger });
  const connections = sharedStreamState?.connections ?? new Set();
  const conversationListeners = new Set();
  let database, controlDb, notebook, retrieval, workerThread;
  let latestSnapshot = progress.snapshot();
  let closed = false, closing;

  // Synchronizes a worker thread progress snapshot into the parent progress collector and caches it for fast status reads.
  // Business purpose: ensures `runtime.status()` and `onProgress` callbacks observe the exact stage, counters, checkpoint, and embedding counts produced by the Worker Thread.
  // Technical description: replays stage transitions, embedding state, failure state, and completion onto `progress` while storing `latestSnapshot`.
  function applyWorkerSnapshot(snap) {
    if (!snap || typeof snap !== "object") return;
    latestSnapshot = snap;
    try {
      if (snap.stage && progress.snapshot().stage !== snap.stage) progress.stage(snap.stage);
      if (snap.embedding) progress.embedding(snap.embedding);
      if (snap.status === "failed") {
        const firstFailure = snap.failures?.find((item) => !item.resolved) ?? { message: "Required indexing work failed.", marker: "index_failed" };
        progress.fail(Object.assign(new Error(firstFailure.message), { code: firstFailure.marker }));
      } else if (snap.status === "succeeded") {
        if (database) progress.reconcile(database);
        progress.finish();
      }
      latestSnapshot = {
        ...progress.snapshot(),
        ...snap,
        stages: { ...progress.snapshot().stages, ...(snap.stages ?? {}) },
        counters: { ...progress.snapshot().counters, ...(snap.counters ?? {}) },
        embedding: { ...progress.snapshot().embedding, ...(snap.embedding ?? {}) }
      };
      onProgress(latestSnapshot);
      // eslint-disable-next-line no-silent-catch -- Ignore progress replay errors after runtime teardown.
    } catch { /* Preserve latestSnapshot even if the parent collector already settled. */ }
  }

  const bridge = createApplicationBridge({ projectId, bus, subscriptions, conversationListeners, isClosed: () => closed });
  const conversationBusProxy = {
    // Subscribes an active SSE connection listener to the project-bound communication bus.
    // Business purpose: streams live conversation messages to connected project SSE clients.
    // Technical description: registers `listener` in `conversationListeners` and forwards it to `boundServices.bus`.
    subscribeAll(listener) { conversationListeners.add(listener); bridge.getBoundServices()?.bus?.subscribeAll?.(listener); },
    // Unsubscribes an SSE connection listener from the project-bound communication bus on disconnect.
    // Business purpose: cleans up conversation message listeners when a client closes its SSE stream.
    // Technical description: removes `listener` from `conversationListeners` and `boundServices.bus`.
    unsubscribeAll(listener) { conversationListeners.delete(listener); bridge.getBoundServices()?.bus?.unsubscribeAll?.(listener); }
  };
  const stream = createProjectStream({
    projectId,
    indexDb: { all: (...args) => database ? database.all(...args) : [] },
    runtimeSnapshot: () => {
      const current = status();
      return { readiness: current.readiness, stage: current.progress.stage, status: current.progress.status, progress: current.progress };
    },
    subscriptions, eventBus: bus, bus: conversationBusProxy,
    agentActivitySnapshot: (args) => bridge.getBoundServices()?.executionActivity?.snapshot?.(args) ?? []
  });

  // Returns the current readiness and indexing progress snapshot for the Worker Thread runtime.
  // Business purpose: exposes non-blocking runtime status to `/forge/v1/projects` and SSE snapshots without querying SQLite on the main thread during heavy indexing.
  // Technical description: reads `latestSnapshot` pushed by the Worker Thread and computes `readiness` (`running`, `ready`, or `unavailable`).
  function status() {
    const snap = latestSnapshot ?? progress.snapshot();
    return {
      projectId, projectRoot, embeddingError: snap.embedding?.error ?? null, closed,
      readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running",
      progress: snap
    };
  }

  // Attaches an HTTP response to the project's live SSE stream and tracks it for clean disposal.
  // Business purpose: allows UI clients to stream real-time progress while the Worker Thread is normalizing comments and indexing files.
  // Technical description: delegates to `stream.connect(input)` and registers a close listener on `input.response`.
  function connect(input) {
    if (closed) throw new Error("Project runtime is closed.");
    const connection = stream.connect(input);
    const response = input.response;
    // Releases the SSE stream connection when the client disconnects or the project is removed.
    // Business purpose: prevents dangling HTTP streams after a project closes.
    // Technical description: removes the connection handle and calls `connection.close()`.
    function disconnect() {
      connections.delete(owned);
      response.off?.("close", disconnect);
      connection.close();
    }
    const owned = { close: disconnect };
    connections.add(owned);
    response.once?.("close", disconnect);
    return owned;
  }

  // Stops the Worker Thread, closes all active SSE connections, and releases the main-thread SQLite handles.
  // Business purpose: guarantees clean resource disposal when a project is removed or the Control API shuts down.
  // Technical description: sends `{ type: "stop" }` to `workerThread`, terminates the thread after cleanup, and closes `database` and `controlDb`.
  function close() {
    closed = true;
    closing ??= (async () => {
      const errors = [];
      try { bridge.unbind(); } catch (error) { errors.push(error); }
      for (const connection of [...connections]) {
        try { connection.close(); } catch (error) { errors.push(error); }
      }
      if (workerThread) {
        try {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000);
            timer.unref?.();
            // Resolves the stop handshake once the worker confirms shutdown or exits.
            // Business purpose: bounds worker thread teardown latency during project removal.
            // Technical description: clears the fallback timeout and resolves the promise on `stopped` or `exit`.
            const finishStop = () => { clearTimeout(timer); resolve(); };
            workerThread.once("exit", finishStop);
            workerThread.on("message", (msg) => { if (msg?.type === "stopped") finishStop(); });
            workerThread.postMessage({ type: "stop" });
          });
          await workerThread.terminate();
        } catch (error) { errors.push(error); }
      }
      try { await database?.close(); } catch (error) { errors.push(error); }
      try { await controlDb?.close(); } catch (error) { errors.push(error); }
      bus.removeAllListeners();
      if (errors.length) throw new AggregateError(errors, "Project worker runtime cleanup failed.");
    })();
    return closing;
  }

  try {
    onRuntimeCreated?.(Object.freeze({ projectRoot, projectId, bus, connect, bindApplication: bridge.bindApplication, close, status }));
    controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    notebook = createNotebookStore({ controlDb, projectId });
    const databaseExisted = await indexDatabaseExists(projectRoot);
    if (!databaseExisted) await ensureRuntimeDir(projectRoot);
    database = await openIndexDatabase(projectRoot, { runtimeDir: INDEX_RUNTIME_DIR });
    retrieval = createRetrievalDependencies({ database, ollamaConfig });

    await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      workerThread = new Worker(WORKER_SCRIPT_URL, {
        workerData: {
          projectRoot, projectId, ollamaConfig, chokidarOptions,
          normalizeComments, rejectOnViolation, fallbackOnViolation,
          awaitInitialEmbeddings, embeddingPollMs
        }
      });
      workerThread.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "progress") applyWorkerSnapshot(message.snapshot);
        else if (message.type === "bus_event") bus.emit(message.eventType, message.event);
        else if (message.type === "log") {
          const logFn = logger?.[message.level] ?? logger?.info;
          if (typeof logFn === "function") logFn.call(logger, message.message, message.meta);
        } else if (message.type === "ready") {
          applyWorkerSnapshot(message.snapshot);
          if (!settled) { settled = true; resolveReady(); }
        } else if (message.type === "failed") {
          if (message.snapshot) applyWorkerSnapshot(message.snapshot);
          if (!settled) {
            settled = true;
            rejectReady(Object.assign(new Error(message.error?.message ?? "Project indexing worker failed."), {
              ...(message.error?.code ? { code: message.error.code } : {}),
              ...(message.error?.stage ? { stage: message.error.stage } : {}),
              ...(message.error?.rolledBack !== undefined ? { rolledBack: message.error.rolledBack } : {})
            }));
          }
        }
      });
      workerThread.once("error", (error) => { if (!settled) { settled = true; rejectReady(error); } });
      workerThread.once("exit", (code) => {
        if (!settled && code !== 0) { settled = true; rejectReady(new Error(`Project indexing worker exited with code ${code}.`)); }
      });
    });

    return Object.freeze({
      projectRoot, projectId, bus, database, controlDb, notebook,
      watch: { close: () => close() },
      worker: { notify() {}, stop: () => close() },
      connect, bindApplication: bridge.bindApplication, close,
      search: retrieval.search, embeddingStore: retrieval.embeddingStore,
      embeddingProvider: retrieval.embeddingProvider, status
    });
  } catch (error) {
    progress.fail(error);
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Project worker runtime startup and rollback failed.");
    }
    throw error;
  }
}
