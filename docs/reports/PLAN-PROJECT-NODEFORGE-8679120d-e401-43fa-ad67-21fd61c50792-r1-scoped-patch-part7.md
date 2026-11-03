# Scoped Unified Git Diff (Part 7 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 931–1085 of 1395

```diff
+
+  const projectWorkers = startControlApiWorkers({
+    projectRoot,
+    projectId: "PROJECT-DEFAULT",
+    indexDb,
+    runtimeLogger,
+    watcherFactory: () => rawWatcher,
+    ollamaConfig: { host: "http://127.0.0.1:11434", model: "test-embed-model", timeoutMs: 1000 },
+    embeddingProvider: {
+      // Simulates one transient failure followed by deterministic vector generation on wake/poll.
+      async embed(text) {
+        if (failOnce) {
+          failOnce = false;
+          throw new Error("Transient Ollama timeout");
+        }
+        embeddedInputs.push(text);
+        return [0.25, 0.5, 0.75];
+      },
+      async close() {
+        teardownEvents.push("embeddingProvider");
+      }
+    },
+    pollMs: 50,
+    debounceMs: 100,
+    renameWindowMs: 100,
+    runVerification: false
+  });
+  context.after(async () => {
+    await projectWorkers.stop();
+    // eslint-disable-next-line no-silent-catch -- Database is already closed when shutdown assertions succeed.
+    try { await indexDb.close(); } catch { /* already closed by shutdown */ }
+  });
+
+  assert.ok(persistedLogs.some((entry) => entry.event_name === "embedding_worker.recovered" && entry.payload?.count === 1));
+  assert.ok(persistedLogs.some((entry) => entry.event_name === "watcher.ready"));
+  assert.ok(terminalOutput.join("").includes("Project filesystem watcher ready (polling)."));
+  assert.ok(terminalOutput.join("").includes("Recovered 1 interrupted embedding job(s)."));
+
+  const startRuntime = createControlApiProjectRuntime({
+    projectRoot,
+    projectId: "PROJECT-DEFAULT",
+    getDefaultWorkers: () => projectWorkers,
+    startRuntime: () => assert.fail("must not start duplicate workers for default project")
+  });
+  const admitted = await startRuntime({ projectRoot, projectId: "PROJECT-DEFAULT" });
+  assert.equal(admitted.watch, projectWorkers.watch);
+  assert.equal(admitted.worker, projectWorkers.worker);
+  assert.equal(admitted.status().closed, false);
+
+  const filePath = join(projectRoot, "src", "service.js");
+  await writeFile(
+    filePath,
+    "// Checkout order service module.\n\n// Computes order totals and persists invoice state for checkout requests.\nexport function calculateOrderTotal(items) {\n  return items.length;\n}\n"
+  );
+  rawWatcher.emit("add", filePath);
+
+  await waitFor(() => persistedLogs.some((entry) => entry.event_name === "watcher.indexed" && entry.status === "success"));
+  await waitFor(() => persistedLogs.some((entry) => entry.event_name === "embedding_worker.failed"));
+
+  // Enqueue a second file update so the Watcher Worker wakes the Embedding Worker immediately via notify().
+  await writeFile(
+    filePath,
+    "// Checkout order service module.\n\n// Computes updated order totals and tax breakdown for checkout requests.\nexport function calculateOrderTotal(items) {\n  return items.length + 1;\n}\n"
+  );
+  rawWatcher.emit("change", filePath);
+
+  await waitFor(() => {
+    const rows = indexDb.all("SELECT symbol_id, embedding_model FROM symbol_embeddings");
+    return rows.length === 1 ? rows[0] : null;
+  });
+
+  await waitFor(() => persistedLogs.some((entry) => entry.event_name === "embedding_worker.completed"));
+  assert.ok(embeddedInputs.length >= 1);
+  assert.ok(persistedLogs.some((entry) => entry.event_name === "watcher.event"));
+  assert.ok(terminalOutput.join("").includes("Indexer updated file."));
+  assert.ok(terminalOutput.join("").includes("Embedding job failed."));
+  assert.ok(terminalOutput.join("").includes("Embedding job completed (1 done, 0 queued, 1 vectors)."));
+
+  const api = startControlApi({
+    api: { createServer },
+    port: 0,
+    host: "127.0.0.1",
+    workers: [projectWorkers],
+    indexDb: { close: async () => { teardownEvents.push("indexDb"); await indexDb.close(); } },
+    controlDb: { close: async () => { teardownEvents.push("controlDb"); } },
+    processLock: { release: () => { teardownEvents.push("processLock"); } }
+  });
+  await once(api.server, "listening");
+  await api.shutdown();
+
+  assert.equal(admitted.status().closed, true);
+  assert.deepEqual(teardownEvents, ["watcher", "embeddingProvider", "indexDb", "controlDb", "processLock"]);
+}
+
+test("Control API in-process Watcher and Embedding Workers index files, compute vectors, log to terminal, and close before SQLite", verifyInProcessControlApiWorkers);
+
+// Business purpose: verifies multi-project lifecycle startup with a single default-project worker pair and SIGTERM/SIGINT signal-driven Control API shutdown.
+// Technical description: admits two catalog projects through createProjectLifecycle, confirms only non-default projects invoke the fallback runtime starter while the default project reuses its in-process worker pair, and spawns child Control API processes to verify SIGTERM and SIGINT teardown ordering.
+async function verifyMultiProjectAndSignalShutdown(context) {
+  const { spawn } = await import("node:child_process");
+  const { resolve } = await import("node:path");
+  const workspace = await mkdtemp(join(tmpdir(), "nodeforge-multiproject-signal-"));
+  context.after(() => rm(workspace, { recursive: true, force: true }));
+  const defaultRoot = join(workspace, "default-project");
+  const secondRoot = join(workspace, "second-project");
+  await mkdir(join(defaultRoot, ".forge/runtime/wc"), { recursive: true });
+  await mkdir(join(secondRoot, ".forge/runtime/wc"), { recursive: true });
+  await writeFile(join(defaultRoot, ".forge/runtime/project.json"), JSON.stringify({
+    project_id: "PROJECT-DEFAULT", name: "default-project", root: defaultRoot, forge_dir: ".forge", schema_version: "1.2.0"
+  }));
+  await writeFile(join(secondRoot, ".forge/runtime/project.json"), JSON.stringify({
+    project_id: "PROJECT-SECOND", name: "second-project", root: secondRoot, forge_dir: ".forge", schema_version: "1.2.0"
+  }));
+  await writeFile(join(defaultRoot, ".forge/runtime/wc/index.db"), "opaque-default-index");
+  await writeFile(join(secondRoot, ".forge/runtime/wc/index.db"), "opaque-second-index");
+
+  const teardownOrder = [];
+  const rawWatcher = new EventEmitter();
+  rawWatcher.close = async () => { teardownOrder.push("defaultWatcher"); };
+  let defaultWorkerPairCount = 0;
+  const fakeDefaultWorkers = {
+    watch: rawWatcher,
+    worker: { stop: async () => { teardownOrder.push("defaultEmbeddingWorker"); } },
+    // Reports whether the default worker pair has been closed.
+    status() { return { closed: teardownOrder.includes("defaultWatcher") }; },
+    // Stops both default project workers in deterministic order.
+    async stop() {
+      await rawWatcher.close();
+      await this.worker.stop();
+    }
+  };
+  defaultWorkerPairCount += 1;
+
+  const secondaryStarted = [];
+  const catalogPath = join(workspace, "projects.json");
+  await writeFile(catalogPath, JSON.stringify([
+    { root: defaultRoot, projectId: "PROJECT-DEFAULT" },
+    { root: secondRoot, projectId: "PROJECT-SECOND" }
+  ]));
+
+  const lifecycle = await createProjectLifecycle({
+    catalogPath,
+    startRuntime: createControlApiProjectRuntime({
+      projectRoot: defaultRoot,
+      projectId: "PROJECT-DEFAULT",
+      getDefaultWorkers: () => fakeDefaultWorkers,
+      // Tracks non-default project runtime admissions during multi-project catalog startup.
+      startRuntime: async (input) => {
+        secondaryStarted.push(input.projectId);
+        let closed = false;
+        return {
+          projectId: input.projectId,
+          projectRoot: input.projectRoot,
+          // Reports secondary runtime closure status.
+          status() { return { closed }; },
```
