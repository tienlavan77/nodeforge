# Scoped Unified Git Diff (Part 2 of 5) — PLAN-PROJECT-NODEFORGE-d2d6d55e-9c9e-4d87-9f13-c8ba14c2ac68 (r1)

- **Base Commit SHA**: `e135298283064f177481325dbb2dccea298d94b7` (`tree_sha: 969aebda64fd8a2cfa0f7a3509219ae9b2a5f2ef`)
- **Review / Implementation Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Files in Part 2**:
  6. `backend/src/modules/projects/project-runtime.js`

```diff
diff --git a/backend/src/modules/projects/project-runtime.js b/backend/src/modules/projects/project-runtime.js
index 8bffe72..84b3392 100644
--- a/backend/src/modules/projects/project-runtime.js
+++ b/backend/src/modules/projects/project-runtime.js
@@ -1,9 +1,9 @@
 // Composes an isolated index, watcher, embedding worker, and activity stream for one project.
 import { EventEmitter } from "node:events";
 import { createIndexProgress } from "../index/index-progress.js";
-import { openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
+import { ensureRuntimeDir, openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
 import { createNotebookStore } from "./notebook-store.js";
-import { startProjectWatch } from "../watcher/watch-project.js";
+import { INDEX_RUNTIME_DIR, indexDatabaseExists, startProjectWatch } from "../watcher/watch-project.js";
 import { createEmbeddingJobStore } from "../index/embedding-job-store.js";
 import { purposeSummaryInput } from "../index/purpose-summary-input.js";
 import { createEmbeddingWorker } from "../index/embedding-worker.js";
@@ -12,7 +12,7 @@ import { createSubscriptionRegistry } from "../events/subscription-registry.js";
 import { createProjectStream } from "../../transport/sse/project-stream.js";
 
 // Starts every per-project service without introducing an HTTP or CLI management contract.
-export async function startProjectRuntime({ projectRoot, projectId, logger = console, embeddingProvider, ollamaConfig, chokidarOptions, watcherFactory, onProgress = () => {}, progress = createIndexProgress({ onProgress }), normalizeComments = true, coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false, onRuntimeCreated = null } = {}) {
+export async function startProjectRuntime({ projectRoot, projectId, logger = console, embeddingProvider, ollamaConfig, chokidarOptions, watcherFactory, onProgress = () => {}, progress = createIndexProgress({ onProgress }), normalizeComments = true, coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false, onRuntimeCreated = null, awaitInitialEmbeddings = true, embeddingPollMs = 1000 } = {}) {
   const bus = new EventEmitter();
   const subscriptions = createSubscriptionRegistry({ logger });
   const connections = new Set();
@@ -58,6 +58,7 @@ export async function startProjectRuntime({ projectRoot, projectId, logger = con
     projectId,
     indexDb: { all: (...args) => database ? database.all(...args) : [] },
     runtimeSnapshot: () => {
+      syncEmbeddingProgress();
       const snap = trackedProgress.snapshot();
       return { readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running", stage: snap.stage, status: snap.status, progress: snap };
     },
@@ -65,12 +66,16 @@ export async function startProjectRuntime({ projectRoot, projectId, logger = con
     eventBus: bus
   });
   // Synchronizes durable embedding job counts into the index progress collector.
-  function syncEmbeddingProgress() {
+  function syncEmbeddingProgress(job, outcome) {
+    if (outcome?.status === "completed") workerLogger.clearEmbeddingError();
     const counts = closed || !embeddingJobs ? null : embeddingJobs.counts();
     if (counts) {
+      const unresolvedError = !closed && database ? database.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null : null;
+      if (unresolvedError) embeddingError ??= unresolvedError;
+      const hasFailure = Boolean(embeddingError || counts.failed || counts.retry_wait);
       trackedProgress.embedding({
-        status: embeddingError ? "failed" : counts.pending || counts.processing || counts.retry_wait ? "running" : "succeeded",
-        ...(embeddingError ? { error: String(embeddingError) } : {}),
+        status: hasFailure ? "failed" : counts.pending || counts.processing ? "running" : "succeeded",
+        error: embeddingError ? String(embeddingError) : null,
         pending: (counts.pending ?? 0) + (counts.retry_wait ?? 0),
         processing: counts.processing ?? 0,
         succeeded: counts.completed ?? 0,
@@ -95,47 +100,76 @@ export async function startProjectRuntime({ projectRoot, projectId, logger = con
       trackedProgress.embedding({ status: "failed", error: String(detail.error) });
       logger.warn?.(message, { ...detail, projectId });
       bus.emit("embedding.failed", { projectId, error: detail.error });
+    },
+    // Clears transient Ollama error state after a retry succeeds and no failed or retry_wait jobs remain.
+    clearEmbeddingError() {
+      const unresolved = !closed && database ? database.all("SELECT last_error FROM embedding_jobs WHERE status IN ('failed', 'retry_wait') AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0]?.last_error ?? null : null;
+      embeddingError = unresolved;
     }
   };
   try {
     onRuntimeCreated?.(Object.freeze({ projectRoot, projectId, bus, connect, close, status }));
     controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
     notebook = createNotebookStore({ controlDb, projectId });
+    const databaseExisted = await indexDatabaseExists(projectRoot);
+    if (!databaseExisted) await ensureRuntimeDir(projectRoot);
+    database = await openIndexDatabase(projectRoot, { runtimeDir: INDEX_RUNTIME_DIR });
+    retrieval = createRetrievalDependencies({ database, ollamaConfig });
+    embeddingProvider ??= retrieval.embeddingProvider;
+    const model = retrieval.ollamaConfig.model;
+    embeddingJobs = createEmbeddingJobStore({
+      database,
+      // Synchronizes durable embedding queue counters into runtime progress and wakes the idle embedding worker when a symbol summary job is enqueued.
+      onEnqueue() {
+        syncEmbeddingProgress();
+        worker?.notify?.();
+      }
+    });
+    embeddingJobs.recoverProcessing();
+    worker = createEmbeddingWorker({
+      database,
+      jobs: embeddingJobs,
+      embeddingStore: retrieval.embeddingStore,
+      embeddingProvider,
+      model,
+      logger: workerLogger,
+      onJobClaimed: syncEmbeddingProgress,
+      onJobSettled: syncEmbeddingProgress
+    });
     watch = await startProjectWatch({
-      projectRoot, projectId, internalBus: bus, reconcile: true, logger, chokidarOptions, watcherFactory, progress: trackedProgress,
+      projectRoot, projectId, database, databaseExisted, deferReadiness: true,
+      internalBus: bus, reconcile: true, logger, chokidarOptions, watcherFactory, progress: trackedProgress,
       normalizeComments, coderNormalizer, rejectOnViolation, fallbackOnViolation,
-      // Shares one project database between indexing, semantic retrieval, and its durable worker.
-      prepareDatabase(indexDb) {
-        database = indexDb;
-        retrieval = createRetrievalDependencies({ database, ollamaConfig });
-        embeddingProvider ??= retrieval.embeddingProvider;
-        const jobs = createEmbeddingJobStore({ database });
-        embeddingJobs = jobs;
-        jobs.recoverProcessing();
-        worker = createEmbeddingWorker({ database, jobs, embeddingStore: retrieval.embeddingStore, embeddingProvider, model: retrieval.ollamaConfig.model, logger: workerLogger });
-        return {
-          indexOptions: { embeddingJobs: jobs, embeddingModel: retrieval.ollamaConfig.model },
-          // Drains initial symbol embeddings during the embedding stage before marking the project ready.
-          async runInitialEmbeddings() {
-            await new Promise((resolve) => setImmediate(resolve));
-            queueMissingEmbeddings();
-            syncEmbeddingProgress();
-            while (!closed && !embeddingError && await worker.runOnce()) {
-              syncEmbeddingProgress();
-            }
-            syncEmbeddingProgress();
-          },
-          close: stopEmbedding
-        };
+      indexOptions: {
+        embeddingJobs,
+        embeddingModel: model,
+        // Triggers an immediate wake signal on the embedding worker and refreshes progress after the watcher worker extracts and queues a symbol summary.
+        onSummaryQueued() {
+          syncEmbeddingProgress();
+          worker.notify();
+        }
       }
     });
-    workerTask = worker.start();
+    trackedProgress.stage("embedding");
+    await new Promise((resolve) => setImmediate(resolve));
+    queueMissingEmbeddings();
+    syncEmbeddingProgress();
+    if (awaitInitialEmbeddings) {
+      while (!closed && !embeddingError && await worker.runOnce()) {
+        syncEmbeddingProgress();
+      }
+      syncEmbeddingProgress();
+    }
+    workerTask = worker.start({ pollMs: embeddingPollMs });
     workerTask = workerTask.catch((error) => {
       embeddingError = error.message;
       trackedProgress.embedding({ status: "failed", error: error.message });
       logger.error?.("Project embedding worker stopped.", { projectId, error });
     });
-    return Object.freeze({ projectRoot, projectId, bus, database, controlDb, notebook, worker, connect, close,
+    trackedProgress.stage("startup/readiness");
+    trackedProgress.reconcile(database);
+    trackedProgress.finish();
+    return Object.freeze({ projectRoot, projectId, bus, database, controlDb, notebook, watch, worker, connect, close,
       search: retrieval.search, embeddingStore: retrieval.embeddingStore, embeddingProvider, status
     });
   } catch (error) {
@@ -180,8 +214,8 @@ export async function startProjectRuntime({ projectRoot, projectId, logger = con
 
   // Cancels Ollama requests and awaits the worker before its database can be closed.
   async function stopEmbedding() {
-    worker?.stop();
-    try { await embeddingProvider?.close?.(); } finally { await workerTask; }
+    const runningTask = worker?.stop();
+    try { await embeddingProvider?.close?.(); } finally { await (workerTask ?? runningTask); }
   }
 
   // Makes concurrent and repeated removal share the same complete teardown.
@@ -197,7 +231,9 @@ export async function startProjectRuntime({ projectRoot, projectId, logger = con
     for (const connection of [...connections]) {
       try { connection.close(); } catch (error) { errors.push(error); }
     }
-    try { await (watch ? watch.close() : stopEmbedding()); } catch (error) { errors.push(error); }
+    try { await watch?.close(); } catch (error) { errors.push(error); }
+    try { await stopEmbedding(); } catch (error) { errors.push(error); }
+    try { await database?.close(); } catch (error) { errors.push(error); }
     try { await controlDb?.close(); } catch (error) { errors.push(error); }
     bus.removeAllListeners();
     if (errors.length) throw new AggregateError(errors, "Project runtime cleanup failed.");
```
