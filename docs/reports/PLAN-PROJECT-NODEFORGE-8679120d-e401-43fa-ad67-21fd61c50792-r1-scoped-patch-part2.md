# Scoped Unified Git Diff (Part 2 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 156–310 of 1395

```diff
+    event_name: "watcher.config",
+    payload: { project_root: projectRoot, index_database: indexDb.databasePath }
+  });
+
+  watcher.on("event", (event) => {
+    if (closed) return;
+    logger.info(`Watcher event ${event.type}.`, {
+      event_name: "watcher.event",
+      payload: { type: event.type, path: event.payload?.path ?? null, event_id: event.event_id }
+    });
+    const task = indexer.handle(event)
+      .then((indexed) => {
+        if (closed) return null;
+        logger.info(indexed ? "Indexer updated file." : "Indexer skipped file.", {
+          event_name: "watcher.indexed",
+          status: indexed ? "success" : "info",
+          payload: { path: event.payload?.path ?? null, event_id: event.event_id }
+        });
+        publishStreamEvent(event, indexed);
+        return indexed && verification ? verification.run({
+          schema_version: "1.0",
+          commit_id: event.event_id,
+          levels: ["focused"],
+          checks: [{ type: "test", command: "node -e \"process.exit(0)\"", timeout_ms: 1000 }]
+        }) : null;
+      })
+      .then((result) => {
+        if (!result || closed) return;
+        logger.info(`Watcher verification ${result.status}.`, {
+          event_name: "watcher.verification",
+          status: result.status === "failed" ? "failed" : "success",
+          payload: { path: event.payload?.path ?? null, run_id: result.run_id ?? null, event_id: event.event_id }
+        });
+      })
+      .catch((error) => {
+        if (closed) return;
+        logger.error("Watcher verification failed.", {
+          event_name: "watcher.verification_failed",
+          payload: { error: error.message, event_id: event.event_id }
+        });
+      })
+      .finally(() => pendingTasks.delete(task));
+    pendingTasks.add(task);
+  });
+
+  // Stops the Watcher Worker and Embedding Worker cleanly before the shared SQLite database closes.
+  function stop() {
+    closed = true;
+    closing ??= (async () => {
+      const errors = [];
+      try { await watcher.close?.(); } catch (error) { errors.push(error); }
+      await Promise.allSettled([...pendingTasks]);
+      const runningWorker = embeddingWorker.stop();
+      try { await resolvedProvider?.close?.(); } catch (error) { errors.push(error); }
+      try { await (workerTask ?? runningWorker); } catch (error) { errors.push(error); }
+      if (errors.length) throw new AggregateError(errors, "Control API project workers cleanup failed.");
+    })();
+    return closing;
+  }
+
+  return Object.freeze({
+    projectRoot,
+    projectId,
+    watch: watcher,
+    worker: embeddingWorker,
+    embeddingJobs,
+    // Reports whether the in-process Watcher and Embedding Workers are still active.
+    status() { return { projectId, projectRoot, closed }; },
+    stop,
+    close: stop
+  });
+}
+
+// Reuses the Control API's in-process default project runtime once; later admissions start independently owned runtimes.
+export function createControlApiProjectRuntime({ projectRoot, projectId, startRuntime = startProjectRuntime, getDefaultWorkers } = {}) {
   const canonicalRoot = realpath(projectRoot);
   let available = true;
 
-  // Bind catalog membership to the existing application only when root and persisted identity both match.
+  // Binds catalog membership to the existing Control API application only when root and persisted identity both match.
   return async function start(input) {
     if (!available || input.projectRoot !== await canonicalRoot) return startRuntime(input);
     if (input.projectId !== projectId) throw new Error("Catalog and Control API project identity differ.");
@@ -16,9 +232,11 @@ export function createControlApiProjectRuntime({ projectRoot, projectId, startRu
     return Object.freeze({
       projectRoot: input.projectRoot,
       projectId,
-      // Expose admission availability while the application registry owns the database and worker resources.
-      status() { return { projectId, projectRoot: input.projectRoot, closed }; },
-      // Retire this binding; application disposal releases the shared storage without duplicate cleanup.
+      get watch() { return getDefaultWorkers?.()?.watch; },
+      get worker() { return getDefaultWorkers?.()?.worker; },
+      // Exposes admission availability while the application registry owns the database and worker resources.
+      status() { return { projectId, projectRoot: input.projectRoot, closed: closed || Boolean(getDefaultWorkers?.()?.status?.().closed) }; },
+      // Retires this binding; application disposal releases the shared storage and workers without duplicate cleanup.
       close() { closed = true; }
     });
   };
diff --git a/backend/scripts/dev-foreground-view.mjs b/backend/scripts/dev-foreground-view.mjs
index 73971db..1e20b7e 100644
--- a/backend/scripts/dev-foreground-view.mjs
+++ b/backend/scripts/dev-foreground-view.mjs
@@ -10,9 +10,11 @@ let gitCache = { at: 0, text: "git --" };
 let embeddingCache = { at: 0, text: "" };
 
 // Creates a terminal view over the shared service and log state.
-export function createForegroundView({ children, serviceState, logLines, suggestions, isActive, output = process.stdout, getGitInfo, getEmbeddingProgress }) {
+export function createForegroundView({ children, serviceState, logLines, suggestions, isActive, output = process.stdout, projectRoot = process.cwd(), getGitInfo, getEmbeddingProgress }) {
   const readGitInfo = getGitInfo ?? gitInfo;
   const readEmbeddingProgress = getEmbeddingProgress ?? embeddingProgressLine;
+  embeddingCache = { at: 0, text: "", counts: null, lastWorkerLog: "" };
+  let instanceEmbeddingCache = embeddingCache;
 // Summary: Redraws the log area, status bar, and boxed prompt like the Claude Code CLI.
 function render(state) {
   if (!isActive() || !state || state.copyMode || state.selecting) return;
@@ -73,7 +75,7 @@ function drawInputBox(state, boxTop, width) {
   output.write(`\x1b[${boxTop};1H\x1b[2K\x1b[38;5;245m╭${"─".repeat(width - 2)}╮\x1b[0m`);
   output.write(`\x1b[${boxTop + 1};1H\x1b[2K\x1b[38;5;245m│\x1b[0m \x1b[36m${prompt}\x1b[0m`);
   if (state.input.length === 0) {
-    output.write(`\x1b[38;5;245mType a command…  /q quit · /r api|watcher|ui restart\x1b[0m`);
+    output.write(`\x1b[38;5;245mType a command…  /q quit · /r api|ui restart\x1b[0m`);
   } else {
     output.write(visibleText);
   }
@@ -116,44 +118,79 @@ function processStats(pid) {
   } catch { return "--"; }
 }
 
-// Summary: Reads embedding queue counts and renders a progress bar with throughput.
+// Summary: Parses the latest API worker log entries for embedding progress events.
+function parseWorkerLogProgress() {
+  let done = 0;
+  let failed = 0;
+  let active = 0;
+  let vectors = 0;
+  let hasWorkerEvent = false;
+  let lastWorkerLog = "";
+  for (const entry of logLines ?? []) {
+    const line = String(entry?.line ?? "");
+    if (!/embedding_worker\.|Embedding job (?:completed|failed)|Recovered \d+ interrupted embedding job|Indexer updated file/.test(line)) continue;
+    lastWorkerLog = `${entry?.time ?? ""}:${line}`;
+    const recovered = line.match(/Recovered (\d+) interrupted embedding job/);
+    if (recovered) { active = Math.max(active, Number(recovered[1])); hasWorkerEvent = true; }
+    if (line.includes("Embedding job failed")) { failed += 1; hasWorkerEvent = true; }
+    const completed = line.match(/Embedding job completed \((\d+) done, (\d+) queued, (\d+) vectors\)/);
+    if (completed) {
+      done = Number(completed[1]);
+      active = Number(completed[2]);
+      vectors = Number(completed[3]);
+      hasWorkerEvent = true;
+    }
+  }
+  return { hasWorkerEvent, done, failed, active, vectors, lastWorkerLog };
+}
+
```
