# Scoped Unified Git Diff (Part 1 of 5) — PLAN-PROJECT-NODEFORGE-d2d6d55e-9c9e-4d87-9f13-c8ba14c2ac68 (r1)

- **Base Commit SHA**: `e135298283064f177481325dbb2dccea298d94b7` (`tree_sha: 969aebda64fd8a2cfa0f7a3509219ae9b2a5f2ef`)
- **Review / Implementation Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Files in Part 1**:
  1. `backend/src/modules/index/embedding-job-store.js`
  2. `backend/src/modules/index/embedding-worker.js`
  3. `backend/src/modules/index/incremental-indexer.js`
  4. `backend/src/modules/index/index-rebuild.js`
  5. `backend/src/modules/index/index-record-writer.js`

```diff
diff --git a/backend/src/modules/index/embedding-job-store.js b/backend/src/modules/index/embedding-job-store.js
index 22c9b44..fbe6adb 100644
--- a/backend/src/modules/index/embedding-job-store.js
+++ b/backend/src/modules/index/embedding-job-store.js
@@ -5,7 +5,7 @@ import { ConfigurationError } from "../../shared/errors.js";
 const ACTIVE_STATUSES = ["pending", "processing", "retry_wait"];
 
 // Creates the SQLite-backed embedding job store.
-export function createEmbeddingJobStore({ database, clock = () => new Date() } = {}) {
+export function createEmbeddingJobStore({ database, clock = () => new Date(), onEnqueue = null } = {}) {
   if (!database || typeof database.all !== "function" || typeof database.run !== "function") throw new ConfigurationError("Embedding job store requires a database.");
   if (typeof clock !== "function") throw new ConfigurationError("Embedding job store clock must be a function.");
   return Object.freeze({ enqueue, claimNext, recoverProcessing, complete, retry, supersede, counts });
@@ -17,15 +17,17 @@ export function createEmbeddingJobStore({ database, clock = () => new Date() } =
     // Savepoints keep enqueue atomic both independently and inside the writer's
     // freshness transaction, without opening a second top-level transaction.
     database.run("SAVEPOINT embedding_enqueue");
+    let result;
     try {
-      const result = insert();
+      result = insert();
       database.run("RELEASE embedding_enqueue");
-      return result;
     } catch (error) {
       database.run("ROLLBACK TO embedding_enqueue");
       database.run("RELEASE embedding_enqueue");
       throw error;
     }
+    onEnqueue?.(result);
+    return result;
 
     // Defines insert function behavior for embedding-job-store.js.
     function insert() {
diff --git a/backend/src/modules/index/embedding-worker.js b/backend/src/modules/index/embedding-worker.js
index 491455e..2c146eb 100644
--- a/backend/src/modules/index/embedding-worker.js
+++ b/backend/src/modules/index/embedding-worker.js
@@ -3,7 +3,7 @@ import { ConfigurationError } from "../../shared/errors.js";
 import { purposeSummaryInput } from "./purpose-summary-input.js";
 
 // Creates a single-flight Embedding Worker for a project index database.
-export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddingProvider, model, clock = () => new Date(), maxAttempts = 5, retryDelayMs = 30000, logger = console } = {}) {
+export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddingProvider, model, clock = () => new Date(), maxAttempts = 5, retryDelayMs = 30000, logger = console, onJobClaimed = null, onJobSettled = null } = {}) {
   if (!database || typeof database.all !== "function") throw new ConfigurationError("Embedding worker requires a database.");
   if (!jobs || typeof jobs.claimNext !== "function") throw new ConfigurationError("Embedding worker requires an embedding job store.");
   if (!embeddingStore || typeof embeddingStore.upsert !== "function") throw new ConfigurationError("Embedding worker requires an embedding store.");
@@ -11,18 +11,31 @@ export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddin
   if (typeof model !== "string" || !model) throw new ConfigurationError("Embedding worker model is required.");
   let stopped = false;
   let running = false;
+  let notified = false;
+  let activeRun;
   let loopTask;
   let wake;
-  return Object.freeze({ runOnce, start, stop });
+  return Object.freeze({ runOnce, start, stop, notify });
 
   // Claims and processes one ready job, returning whether work was performed.
-  async function runOnce() {
-    if (running) return false;
+  function runOnce() {
+    if (running) return Promise.resolve(false);
     running = true;
+    activeRun = processNextJob().finally(() => {
+      running = false;
+      activeRun = undefined;
+    });
+    return activeRun;
+  }
+
+  // Claims the next ready embedding job from the durable SQLite queue, validates the current symbol purpose summary checksum, computes its vector via embeddingProvider, and persists the vector atomically or schedules a retry on failure.
+  async function processNextJob() {
     let activeJob = null;
+    let outcome = "superseded";
     try {
       activeJob = jobs.claimNext({ now: clock().toISOString() });
       if (!activeJob) return false;
+      onJobClaimed?.(activeJob);
       const symbol = database.all(
         `SELECT summary FROM symbols WHERE symbol_id = ?`,
         [activeJob.symbol_id]
@@ -49,19 +62,27 @@ export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddin
         }
         embeddingStore.upsert({ symbolId: activeJob.symbol_id, vector, model, checksum });
         jobs.complete(activeJob.job_id);
+        outcome = "completed";
       };
       if (database.transaction) database.transaction(publish);
       else publish();
       return true;
     } catch (error) {
+      outcome = "failed";
       if (activeJob?.job_id) jobs.retry(activeJob.job_id, error, { maxAttempts, delayMs: retryDelayMs });
       logger.warning?.("Embedding job failed.", { error: error.message });
       return true;
     } finally {
-      running = false;
+      if (activeJob) onJobSettled?.(activeJob, { status: outcome });
     }
   }
 
+  // Wakes the idle embedding worker immediately when new symbol summary work is pushed from the watcher worker so vector generation starts without waiting for the polling interval.
+  function notify() {
+    notified = true;
+    wake?.();
+  }
+
   // Runs the worker loop with a bounded polling interval.
   function start({ pollMs = 1000 } = {}) {
     if (loopTask) return loopTask;
@@ -74,10 +95,11 @@ export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddin
   // Drains this project's embedding queue without leaving a polling timer after removal.
   async function loop(pollMs) {
     while (!stopped) {
+      notified = false;
       const worked = await runOnce();
-      if (!worked && !stopped) await new Promise((resolveWait) => {
+      if (!worked && !stopped && !notified) await new Promise((resolveWait) => {
         const timer = setTimeout(finish, pollMs);
-        // Wakes the idle worker immediately when the project is removed.
+        // Wakes the idle worker immediately when the project is removed or notified.
         function finish() { clearTimeout(timer); wake = undefined; resolveWait(); }
         wake = finish;
       });
@@ -88,6 +110,6 @@ export function createEmbeddingWorker({ database, jobs, embeddingStore, embeddin
   function stop() {
     stopped = true;
     wake?.();
-    return loopTask;
+    return loopTask ?? activeRun;
   }
 }
diff --git a/backend/src/modules/index/incremental-indexer.js b/backend/src/modules/index/incremental-indexer.js
index 782ba37..fcb67d9 100755
--- a/backend/src/modules/index/incremental-indexer.js
+++ b/backend/src/modules/index/incremental-indexer.js
@@ -11,9 +11,9 @@ import { readContentHash } from "../watcher/debounced-watcher.js";
 import { logEvent } from "../../core/project-log-service.js";
 
 // createIncrementalIndexer - handles createIncrementalIndexer operation.
-export function createIncrementalIndexer({ database, projectRoot, registry = extractorRegistry, files = createFileRepository(database), graph = createDependencyGraph({ database, files, projectRoot }), fileService, getContentHash = readContentHash, logger = console, projectLogger = logEvent, embeddingJobs = null, embeddingStore = null, embeddingProvider = null, embeddingModel = "text-embedding-3-small" } = {}) {
+export function createIncrementalIndexer({ database, projectRoot, registry = extractorRegistry, files = createFileRepository(database), graph = createDependencyGraph({ database, files, projectRoot }), fileService, getContentHash = readContentHash, logger = console, projectLogger = logEvent, embeddingJobs = null, embeddingStore = null, embeddingProvider = null, embeddingModel = "text-embedding-3-small", onSummaryQueued = null } = {}) {
   const conversion = createSummaryConversion(database);
-  const recordWriter = createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, logger });
+  const recordWriter = createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, onSummaryQueued, logger });
   const { writeExtraction, clearContentIndex, indexContent, writeCalls } = recordWriter;
 
   return Object.freeze({
diff --git a/backend/src/modules/index/index-rebuild.js b/backend/src/modules/index/index-rebuild.js
index 9f0c697..93f62b5 100755
--- a/backend/src/modules/index/index-rebuild.js
+++ b/backend/src/modules/index/index-rebuild.js
@@ -15,12 +15,12 @@ import { readContentHash } from "../watcher/debounced-watcher.js";
 const CODE_INDEX_RUNTIME_DIR = statePath("wc");
 
 // Defines rebuildIndex function behavior for index-rebuild.js.
-export async function rebuildIndex({ projectRoot, database, runtimeDir = CODE_INDEX_RUNTIME_DIR, ignore = [], registry = extractorRegistry, indexer, embeddingJobs = null, embeddingModel = "embeddinggemma", onFile = () => {}, onProgress = () => {}, progress = createIndexProgress({ onProgress }), force = false } = {}) {
+export async function rebuildIndex({ projectRoot, database, runtimeDir = CODE_INDEX_RUNTIME_DIR, ignore = [], registry = extractorRegistry, indexer, embeddingJobs = null, embeddingModel = "embeddinggemma", onSummaryQueued = null, onFile = () => {}, onProgress = () => {}, progress = createIndexProgress({ onProgress }), force = false } = {}) {
   await ensureForgeLayout(projectRoot);
   const ownsDatabase = !database;
   const indexDatabase = database ?? await openIndexDatabase(projectRoot, { runtimeDir });
   const conversion = createSummaryConversion(indexDatabase);
-  const incrementalIndexer = indexer ?? createIncrementalIndexer({ database: indexDatabase, projectRoot, registry, embeddingJobs, embeddingModel });
+  const incrementalIndexer = indexer ?? createIncrementalIndexer({ database: indexDatabase, projectRoot, registry, embeddingJobs, embeddingModel, onSummaryQueued });
   // Adapts injected legacy indexers while keeping false distinct from a successful commit.
   async function handle(event) {
     if (incrementalIndexer.handleDetailed) return incrementalIndexer.handleDetailed(event);
diff --git a/backend/src/modules/index/index-record-writer.js b/backend/src/modules/index/index-record-writer.js
index 8a295eb..be56535 100644
--- a/backend/src/modules/index/index-record-writer.js
+++ b/backend/src/modules/index/index-record-writer.js
@@ -7,7 +7,7 @@ import { reconcileSymbols } from "./symbol-reconciliation.js";
 import { purposeComments, purposeCommentBefore } from "./parser/purpose-comments.js";
 
 // Creates database writers that preserve file extraction and symbol search records.
-export function createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, logger }) {
+export function createIndexRecordWriter({ database, graph, embeddingJobs, embeddingStore, embeddingProvider, embeddingModel, onSummaryQueued = null, logger }) {
   // Retains unfinished summary work across reindexing so unchanged summaries reuse
   // the provider request identified by the reconciled symbol, checksum and model.
   const pendingEmbeddings = new Set();
@@ -74,16 +74,21 @@ export function createIndexRecordWriter({ database, graph, embeddingJobs, embedd
     if (embeddingJobs?.enqueue) {
       queueMicrotask(() => {
         try {
+          let queuedJob = null;
           // Schedules only current summary work, atomically with the final check.
           const enqueue = () => {
             const current = database.all("SELECT summary FROM symbols WHERE symbol_id = ?", [symbolId])[0];
             if (purposeSummaryInput(current?.summary)?.checksum !== checksum) return;
             const existing = database.all("SELECT content_checksum, embedding_model FROM symbol_embeddings WHERE symbol_id = ?", [symbolId])[0];
             if (existing?.content_checksum === checksum && existing?.embedding_model === embeddingModel) return;
-            embeddingJobs.enqueue({ symbolId, contentChecksum: checksum, model: embeddingModel });
+            queuedJob = embeddingJobs.enqueue({ symbolId, contentChecksum: checksum, model: embeddingModel });
           };
           if (database.transaction) database.transaction(enqueue);
           else enqueue();
+          if (queuedJob) {
+            embeddingJobs.notify?.(queuedJob);
+            onSummaryQueued?.(queuedJob);
+          }
         } catch (error) { logger.debug?.("Embedding job enqueue skipped.", { path, symbol: name, error: error.message }); }
       });
       return;
```
