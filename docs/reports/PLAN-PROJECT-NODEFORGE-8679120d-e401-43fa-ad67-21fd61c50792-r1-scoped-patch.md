# Scoped Unified Git Diff (Part 1 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 1–155 of 1395

```diff
diff --git a/backend/scripts/control-api-project-runtime.mjs b/backend/scripts/control-api-project-runtime.mjs
index d92d17e..18d32f1 100644
--- a/backend/scripts/control-api-project-runtime.mjs
+++ b/backend/scripts/control-api-project-runtime.mjs
@@ -1,13 +1,229 @@
-// Admit the Control API's existing project without starting a second watcher or rebuilding its index.
+// Manages in-process Watcher and Embedding Workers for the Control API and coordinates catalog admission.
 import { realpath } from "node:fs/promises";
+import { createFilesystemWatcher, DEFAULT_WATCHER_IGNORE } from "../src/infrastructure/filesystem/watcher.js";
+import { createDebouncedWatcher } from "../src/modules/watcher/debounced-watcher.js";
+import { createIncrementalIndexer } from "../src/modules/index/incremental-indexer.js";
+import { createEmbeddingJobStore } from "../src/modules/index/embedding-job-store.js";
+import { createEmbeddingWorker } from "../src/modules/index/embedding-worker.js";
+import { createRetrievalDependencies } from "../src/modules/index/retrieval-dependencies.js";
+import { createVerificationOrchestrator } from "../src/modules/verification/orchestrator.js";
+import { createWatcherCacheEvents } from "../src/modules/context/watcher-cache-events.js";
+import { createRuntimeLogger } from "../src/core/runtime-logger.js";
 import { startProjectRuntime } from "../src/modules/projects/project-runtime.js";
 
-// Reuse the application's already-open storage once; later admissions start independently owned runtimes.
-export function createControlApiProjectRuntime({ projectRoot, projectId, startRuntime = startProjectRuntime }) {
+// Starts separated Watcher Worker and Embedding Worker inside the Control API process over shared storage and logging.
+export function startControlApiWorkers({
+  projectRoot,
+  projectId,
+  indexDb,
+  runtimeLogger,
+  logEvent,
+  codeCache,
+  subscriptions,
+  chokidarOptions,
+  watcherFactory = createFilesystemWatcher,
+  embeddingProvider,
+  ollamaConfig,
+  pollMs = 1000,
+  runVerification = true,
+  debounceMs,
+  renameWindowMs
+} = {}) {
+  const logger = runtimeLogger ?? createRuntimeLogger({ logEvent, source: "project-watcher" });
+  const retrieval = createRetrievalDependencies({ database: indexDb, ollamaConfig });
+  const resolvedProvider = embeddingProvider ?? retrieval.embeddingProvider;
+  const embeddingModel = retrieval.ollamaConfig.model;
+  let closed = false;
+  let embeddingWorker;
+  const embeddingJobs = createEmbeddingJobStore({
+    database: indexDb,
+    // Wakes the in-process Embedding Worker immediately when an embedding job is enqueued.
+    onEnqueue() {
+      embeddingWorker?.notify?.();
+    }
+  });
+  embeddingWorker = createEmbeddingWorker({
+    database: indexDb,
+    jobs: embeddingJobs,
+    embeddingStore: retrieval.embeddingStore,
+    embeddingProvider: resolvedProvider,
+    model: embeddingModel,
+    logger: {
+      // Forwards transient Ollama or embedding job failures to the Control API runtime logger.
+      warning(message, detail = {}) {
+        logger.error(message, {
+          event_name: "embedding_worker.failed",
+          payload: { error: detail.error ?? message }
+        });
+      }
+    },
+    // Logs completed embedding jobs with queue and vector counts for terminal progress tracking.
+    onJobSettled(job, { status } = {}) {
+      if (closed || status !== "completed") return;
+      const counts = embeddingJobs.counts();
+      const queued = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
+      const vectors = Number(indexDb.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0]?.count ?? 0);
+      logger.info(`Embedding job completed (${counts.completed ?? 0} done, ${queued} queued, ${vectors} vectors).`, {
+        event_name: "embedding_worker.completed",
+        status: "success",
+        payload: { job_id: job.job_id, symbol_id: job.symbol_id, model: embeddingModel, counts, vectors }
+      });
+    }
+  });
+  const recoveredEmbeddingJobs = embeddingJobs.recoverProcessing();
+  if (recoveredEmbeddingJobs > 0) {
+    logger.info(`Recovered ${recoveredEmbeddingJobs} interrupted embedding job(s).`, {
+      event_name: "embedding_worker.recovered",
+      payload: { count: recoveredEmbeddingJobs, model: embeddingModel }
+    });
+  }
+  const rawWatcher = watcherFactory({
+    root: projectRoot,
+    ignore: DEFAULT_WATCHER_IGNORE,
+    chokidarOptions: { ignoreInitial: true, usePolling: true, interval: 250, ...chokidarOptions }
+  });
+  const watcher = createDebouncedWatcher({
+    rawWatcher,
+    projectId,
+    root: projectRoot,
+    ...(debounceMs !== undefined ? { debounceMs } : {}),
+    ...(renameWindowMs !== undefined ? { renameWindowMs } : {})
+  });
+  watcher.on("watcher.error", (error) => {
+    logger.error("Project watcher reported an event error.", {
+      event_name: "watcher.failed",
+      payload: { error: error.message, code: error.code ?? null }
+    });
+  });
+  const indexer = createIncrementalIndexer({
+    database: indexDb,
+    projectRoot,
+    embeddingJobs,
+    embeddingModel,
+    // Signals the Embedding Worker immediately after the Watcher Worker extracts and queues a symbol summary.
+    onSummaryQueued() {
+      embeddingWorker.notify();
+    }
+  });
+  const workerTask = embeddingWorker.start({ pollMs }).catch((error) => {
+    logger.error("Embedding worker stopped.", {
+      event_name: "embedding_worker.failed",
+      payload: { error: error.message }
+    });
+  });
+  const verification = runVerification ? createVerificationOrchestrator({ projectRoot, projectId }) : null;
+  const onWatcherCacheEvent = codeCache ? createWatcherCacheEvents({ projectId, codeCache, logger: logger.emit }) : null;
+  const pendingTasks = new Set();
+  let closing;
+
+  // Publishes indexed file changes to the in-process project stream and code cache without external HTTP calls.
+  function publishStreamEvent(event, indexed) {
+    if (closed) return;
+    try {
+      const indexedFile = indexed && event.type !== "watcher.file_deleted"
+        ? indexDb.all("SELECT sha256 FROM files WHERE path = ? LIMIT 1", [event.payload?.path])[0]
+        : null;
+      const envelope = {
+        ...event,
+        event_type: event.type,
+        source: "watcher",
+        metadata: { source: "watcher", project_id: projectId },
+        payload: { ...event.payload, ...(indexedFile?.sha256 ? { sha256: indexedFile.sha256 } : {}) },
+        indexed: Boolean(indexed),
+        project_id: projectId
+      };
+      if (onWatcherCacheEvent && String(envelope.type ?? "").startsWith("watcher.file_")) {
+        void Promise.resolve(onWatcherCacheEvent(envelope)).catch((error) => {
+          logger.info(`Watcher cache update failed: ${error.message}`);
+        });
+      }
+      subscriptions?.publish?.(envelope);
+    } catch (error) {
+      logger.info(`Stream publish unavailable: ${error.message}`);
+    }
+  }
+
+  logger.info("Project filesystem watcher ready (polling).", { event_name: "watcher.ready" });
+  logger.info("Watcher configuration loaded.", {
```
