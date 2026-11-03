# Scoped Unified Git Diff (Part 3 of 5) — PLAN-PROJECT-NODEFORGE-d2d6d55e-9c9e-4d87-9f13-c8ba14c2ac68 (r1)

- **Base Commit SHA**: `e135298283064f177481325dbb2dccea298d94b7` (`tree_sha: 969aebda64fd8a2cfa0f7a3509219ae9b2a5f2ef`)
- **Review / Implementation Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Files in Part 3**:
  7. `backend/src/modules/watcher/watch-project.js`
  8. `backend/tests/unit/embedding-worker.test.js`

```diff
diff --git a/backend/src/modules/watcher/watch-project.js b/backend/src/modules/watcher/watch-project.js
index f28f431..6435989 100755
--- a/backend/src/modules/watcher/watch-project.js
+++ b/backend/src/modules/watcher/watch-project.js
@@ -14,25 +14,28 @@ import { ProjectRegistry } from "../projects/project-registry.js";
 import { normalizeProjectComments } from "../projects/project-comment-normalization.js";
 import { createDebouncedWatcher } from "./debounced-watcher.js";
 
-const INDEX_RUNTIME_DIR = join(".forge", "runtime", "wc");
+export const INDEX_RUNTIME_DIR = join(".forge", "runtime", "wc");
 const INDEX_DATABASE_PATH = [".forge", "runtime", "wc", "index.db"];
 
 // Defines startProjectWatch function behavior for watch-project.js.
-export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOptions, projectId, projectRegistry = new ProjectRegistry(), logger = console, internalBus, prepareDatabase, reconcile = false, onProgress = () => {}, progress = createIndexProgress({ onProgress }), watcherFactory = createFilesystemWatcher, normalizeComments = false, coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false } = {}) {
+export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOptions, projectId, projectRegistry = new ProjectRegistry(), logger = console, internalBus, database: externalDatabase = null, databaseExisted: externalDatabaseExisted = null, indexOptions = null, deferReadiness = false, prepareDatabase, reconcile = false, onProgress = () => {}, progress = createIndexProgress({ onProgress }), watcherFactory = createFilesystemWatcher, normalizeComments = false, coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false } = {}) {
   const root = resolve(projectRoot ?? process.cwd());
   const config = loadConfig({ cwd: root });
   const resolvedProjectId = projectId ?? await projectRegistry.getOrCreate(root);
-  const databaseExisted = await indexDatabaseExists(root);
+  const ownsDatabase = !externalDatabase;
+  const databaseExisted = externalDatabaseExisted ?? await indexDatabaseExists(root);
 
   // Explicitly create the runtime directory before the first baseline rebuild.
-  if (!databaseExisted) await ensureRuntimeDir(root);
+  if (!databaseExisted && ownsDatabase) await ensureRuntimeDir(root);
 
-  let database;
-  try {
-    database = await openIndexDatabase(root, { runtimeDir: INDEX_RUNTIME_DIR });
-  } catch (error) {
-    logger.error?.("Unable to open project index database", { error: error.message, projectRoot: root });
-    throw error;
+  let database = externalDatabase;
+  if (!database) {
+    try {
+      database = await openIndexDatabase(root, { runtimeDir: INDEX_RUNTIME_DIR });
+    } catch (error) {
+      logger.error?.("Unable to open project index database", { error: error.message, projectRoot: root });
+      throw error;
+    }
   }
   let bootstrap;
   let rawWatcher;
@@ -53,7 +56,7 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
       () => bootstrap?.stop(),
       () => watcher ? watcher.close() : rawWatcher?.close(),
       () => resources?.close?.(),
-      () => database.close()
+      () => ownsDatabase ? database.close() : null
     ]) {
       try { await cleanup(); } catch (error) { errors.push(error); }
     }
@@ -61,6 +64,7 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
   }
   try {
     resources = await prepareDatabase?.(database);
+    const resolvedIndexOptions = { ...resources?.indexOptions, ...indexOptions };
     const existingFiles = database.all("SELECT COUNT(*) AS count FROM files")[0].count;
     const baselineRebuilt = reconcile || !databaseExisted || existingFiles === 0;
     if (baselineRebuilt) {
@@ -75,10 +79,10 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
     }
     const baseline = baselineRebuilt
       ? await rebuildIndex({
-        projectRoot: root, database, ignore: config.watcherIgnore, ...resources?.indexOptions, progress,
+        projectRoot: root, database, ignore: config.watcherIgnore, ...resolvedIndexOptions, progress,
         // Defines onFile method behavior for watch-project.js.
         onFile(entry) {
-          resources?.indexOptions?.onFile?.(entry);
+          resolvedIndexOptions?.onFile?.(entry);
           if (internalBus?.emit && entry.phase === "index" && entry.indexed) {
             internalBus.emit("watcher.indexed", {
               project_id: resolvedProjectId, type: "indexer.indexed", indexed: true,
@@ -90,16 +94,9 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
       : { indexedFiles: 0, succeeded: true };
     const baselineIndexedFiles = baseline.indexedFiles;
     if (!baseline.succeeded) throw Object.assign(new Error("Required indexing work failed."), { code: "index_failed", progress: baseline.progress });
-    if (typeof resources?.runInitialEmbeddings === "function") {
-      progress.stage("embedding");
-      await resources.runInitialEmbeddings();
-    } else if (baselineRebuilt) {
-      progress.stage("embedding");
-    }
-    progress.stage("startup/readiness");
 
     const fileService = createFileService({ projectRoot: root, watcherIgnore: config.watcherIgnore });
-    const indexer = createIncrementalIndexer({ database, projectRoot: root, fileService, ...resources?.indexOptions });
+    const indexer = createIncrementalIndexer({ database, projectRoot: root, fileService, ...resolvedIndexOptions });
     rawWatcher = watcherFactory({
       root,
       ignore: config.watcherIgnore,
@@ -121,12 +118,15 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
     bootstrap = createBootstrap({ configOptions: { cwd: root }, loggerOptions, internalBus, watcher, indexer: {
       // Publishes watcher outcomes through the same commit-aware collector used by baseline work.
       async handle(event) {
-        progress.stage("scan/index");
+        const readySettled = !deferReadiness || progress.snapshot().stages["startup/readiness"] !== "pending";
+        if (readySettled) progress.stage("scan/index");
         const result = await indexer.handleDetailed(event);
         progress.result(result);
         progress.reconcile(database);
-        progress.stage("startup/readiness");
-        progress.finish();
+        if (readySettled) {
+          progress.stage("startup/readiness");
+          progress.finish();
+        }
         internalBus?.emit("index.result", result);
         if (result.error && result.marker !== "parse_failed") throw result.error;
         return result.committed;
@@ -134,7 +134,16 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
     } });
     await Promise.all([bootstrap.start(), ready]);
     progress.reconcile(database);
-    progress.finish();
+    if (!deferReadiness) {
+      if (typeof resources?.runInitialEmbeddings === "function") {
+        progress.stage("embedding");
+        await resources.runInitialEmbeddings();
+      } else if (baselineRebuilt) {
+        progress.stage("embedding");
+      }
+      progress.stage("startup/readiness");
+      progress.finish();
+    }
 
     return Object.freeze({
       projectRoot: root,
@@ -154,7 +163,7 @@ export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOp
 }
 
 // Defines indexDatabaseExists function behavior for watch-project.js.
-async function indexDatabaseExists(projectRoot) {
+export async function indexDatabaseExists(projectRoot) {
   try {
     await access(join(projectRoot, ...INDEX_DATABASE_PATH));
     return true;
diff --git a/backend/tests/unit/embedding-worker.test.js b/backend/tests/unit/embedding-worker.test.js
index 5e100d0..82be608 100644
--- a/backend/tests/unit/embedding-worker.test.js
+++ b/backend/tests/unit/embedding-worker.test.js
@@ -61,3 +61,48 @@ test("worker embeds only when the queued checksum is still current", async () =>
     await database.close();
   }
 });
+
+test("worker notify wakes an idle polling loop immediately when a summary job is pushed", async () => {
+  const { database } = await fixture();
+  let worker;
+  let loopTask;
+  try {
+    let settledResolve;
+    const settled = new Promise((resolve) => { settledResolve = resolve; });
+    const vectors = [];
+    const jobs = createEmbeddingJobStore({
+      database,
+      clock: () => new Date("2026-09-19T00:00:00.000Z"),
+      // Wakes the embedding worker immediately when a new symbol summary job is enqueued into SQLite.
+      onEnqueue() {
+        worker?.notify();
+      }
+    });
+    worker = createEmbeddingWorker({
+      database,
+      jobs,
+      // Stores computed vectors in memory so the unit test can assert immediate publication.
+      embeddingStore: { upsert: (value) => vectors.push(value) },
+      // Returns a deterministic vector for the enqueued symbol summary input.
+      embeddingProvider: { embed: async () => [0.5, 0.5] },
+      model: "embeddinggemma",
+      clock: () => new Date("2026-09-19T00:00:00.000Z"),
+      // Resolves the test promise as soon as the woken worker finishes processing the pushed job.
+      onJobSettled(job) {
+        settledResolve(job);
+      }
+    });
+    loopTask = worker.start({ pollMs: 60000 });
+    await new Promise((resolve) => setTimeout(resolve, 20));
+    const checksum = purposeSummaryInput("Protect customer orders.").checksum;
+    jobs.enqueue({ symbolId: "SYM-1", contentChecksum: checksum, model: "embeddinggemma" });
+    const processedJob = await settled;
+    assert.equal(processedJob.symbol_id, "SYM-1");
+    assert.equal(vectors.length, 1);
+    assert.equal(jobs.counts().completed, 1);
+  } finally {
+    worker?.stop();
+    await loopTask;
+    await database.close();
+  }
+});
```
