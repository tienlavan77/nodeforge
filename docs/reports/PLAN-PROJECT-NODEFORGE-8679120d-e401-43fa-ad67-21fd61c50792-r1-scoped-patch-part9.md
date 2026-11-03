# Scoped Unified Git Diff (Part 9 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 1241–1395 of 1395

```diff
+  while (Date.now() < deadline) {
+    const value = await predicate();
+    if (value) return value;
+    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
+  }
+  throw new Error(`Timed out waiting for foreground controller condition: ${getDebug()}`);
+}
+
+// Business purpose: verifies real supervised API child process startup, worker-log-driven embedding progress rendering, /r api process restart, and SIGTERM cleanup.
+// Technical description: spawns a real Node API subprocess running startControlApiWorkers and startControlApi over SQLite, triggers file indexing and vector completion logs, renders createForegroundView without stubs, executes /r api to replace the running PID, and shuts down via /q.
+async function verifyForegroundApiRestartAndWorkerLogProgress(context) {
+  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-foreground-api-"));
+  context.after(() => rm(projectRoot, { recursive: true, force: true }));
+  await mkdir(join(projectRoot, "src"), { recursive: true });
+  const repoRoot = resolve(process.cwd());
+  const apiScriptPath = join(projectRoot, "run-api-fixture.mjs");
+  await writeFile(apiScriptPath, [
+    `import { createServer } from "node:http";`,
+    `import { EventEmitter } from "node:events";`,
+    `import { join } from "node:path";`,
+    `import { writeFile } from "node:fs/promises";`,
+    `import { createDatabaseService } from ${JSON.stringify(join(repoRoot, "backend/src/infrastructure/sqlite/database-service.js"))};`,
+    `import { createRuntimeLogger } from ${JSON.stringify(join(repoRoot, "backend/src/core/runtime-logger.js"))};`,
+    `import { startControlApiWorkers } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-project-runtime.mjs"))};`,
+    `import { startControlApi } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-lifecycle.mjs"))};`,
+    `const projectRoot = ${JSON.stringify(projectRoot)};`,
+    `const indexDb = await createDatabaseService({ dataDir: projectRoot, runtimeDir: join(".forge", "runtime", "wc") });`,
+    `const runtimeLogger = createRuntimeLogger({ logEvent: () => {}, output: process.stdout, source: "project-watcher" });`,
+    `const rawWatcher = new EventEmitter();`,
+    `rawWatcher.close = async () => {};`,
+    `const workers = startControlApiWorkers({`,
+    `  projectRoot,`,
+    `  projectId: "PROJECT-FG",`,
+    `  indexDb,`,
+    `  runtimeLogger,`,
+    `  watcherFactory: () => rawWatcher,`,
+    `  debounceMs: 100,`,
+    `  renameWindowMs: 100,`,
+    `  pollMs: 30,`,
+    `  runVerification: false,`,
+    `  ollamaConfig: { host: "http://127.0.0.1:11434", model: "fg-embed-model", timeoutMs: 1000 },`,
+    `  embeddingProvider: { async embed() { return [0.5, 0.25, 0.75]; }, async close() {} }`,
+    `});`,
+    `startControlApi({`,
+    `  api: { createServer },`,
+    `  port: 0,`,
+    `  host: "127.0.0.1",`,
+    `  workers: [workers],`,
+    `  indexDb,`,
+    `  controlDb: { close: async () => {} },`,
+    `  processLock: { release: () => { console.log("API_LOCK_RELEASED"); } }`,
+    `});`,
+    `const target = join(projectRoot, "src", "fg-item-" + process.pid + ".js");`,
+    `const sourceText = ${JSON.stringify("// Foreground watched module.\n\n// Computes item subtotal for foreground worker test.\nexport function computeSubtotal(price) { return price * 2; }\n")};`,
+    `await writeFile(target, sourceText);`,
+    `rawWatcher.emit("add", target);`
+  ].join("\n"));
+
+  const chunks = [];
+  const output = { rows: 24, columns: 110, write: (chunk) => chunks.push(String(chunk)) };
+  const controller = createForegroundController({
+    serviceDefinitions: {
+      api: { command: process.execPath, args: [apiScriptPath], cwd: projectRoot }
+    },
+    output,
+    projectRoot,
+    getGitInfo: () => "main"
+  });
+  context.after(() => controller.shutdown());
+
+  const firstChild = controller.start("api");
+  const firstPid = firstChild.pid;
+  assert.ok(Number.isInteger(firstPid) && firstPid > 0);
+
+  await waitForCondition(() => controller.logLines.some((entry) => entry.line.includes("Embedding job completed (1 done, 0 queued, 1 vectors).")), 4000, () => JSON.stringify(controller.logLines));
+  chunks.length = 0;
+  controller.render({ input: "", cursor: 0, scrollBack: 0, copyMode: false });
+  const liveScreen = chunks.join("");
+  assert.ok(liveScreen.includes("embed "), "renders live embedding progress bar from API worker logs and SQLite");
+  assert.ok(liveScreen.includes("100% · 1/1 done · 0 queued · 1 vectors"), "displays completed embedding job and vector counts");
+
+  const restartResult = await controller.executeCommand("/r api");
+  assert.deepEqual(restartResult, { action: "restart", service: "api" });
+  const secondChild = controller.children.get("api");
+  assert.ok(secondChild && secondChild.pid !== firstPid, "spawns a new API child process on /r api");
+  assert.notEqual(firstChild.exitCode ?? firstChild.signalCode, null, "terminates previous API child process on /r api");
+  assert.ok(controller.logLines.some((entry) => entry.line.includes("api: restarting...")));
+  assert.ok(controller.logLines.some((entry) => entry.name === "api" && entry.line === "stopped"));
+  assert.ok(controller.logLines.some((entry) => entry.line.includes(`api: restarted successfully (pid ${secondChild.pid})`)));
+
+  await waitForCondition(() => controller.logLines.filter((entry) => entry.line.includes("Project filesystem watcher ready (polling).")).length >= 2);
+  const quitResult = await controller.executeCommand("/q");
+  assert.deepEqual(quitResult, { action: "quit" });
+  assert.equal(controller.children.size, 0);
+}
+
+test("dev:foreground supervises real API child startup, renders worker-log-driven embedding progress, and restarts API via /r api", verifyForegroundApiRestartAndWorkerLogProgress);
diff --git a/backend/tests/unit/javascript-extractor.test.js b/backend/tests/unit/javascript-extractor.test.js
index 46a1847..e7fa036 100755
--- a/backend/tests/unit/javascript-extractor.test.js
+++ b/backend/tests/unit/javascript-extractor.test.js
@@ -57,7 +57,9 @@ function first() {
   ]);
 });
 
-test("returns an empty normalized extraction for an unsupported extension", () => {
+// Business purpose: verifies that unsupported file extensions return an empty extraction while .mjs and .cjs modules extract symbols properly.
+// Technical description: checks extractorRegistry.supports and extractorRegistry.extract for .py, extensionless paths, .mjs, and .cjs files.
+function verifyUnsupportedAndModuleExtensions() {
   assert.deepEqual(extractorRegistry.extract("src/example.py", "def run(): pass"), {
     symbols: [],
     imports: [],
@@ -65,7 +67,41 @@ test("returns an empty normalized extraction for an unsupported extension", () =
     calls: []
   });
   assert.equal(extractorRegistry.supports("README"), false);
-});
+  assert.equal(extractorRegistry.supports("scripts/example.mjs"), true);
+  assert.equal(extractorRegistry.supports("scripts/example.cjs"), true);
+  assert.deepEqual(extractorRegistry.extract("scripts/example.mjs", "export function runWorker() { return true; }").symbols, [
+    { name: "runWorker", kind: "function", start_line: 1, end_line: 1 }
+  ]);
+}
+
+test("returns an empty normalized extraction for an unsupported extension", verifyUnsupportedAndModuleExtensions);
+
+// Business purpose: verifies that Reviewer scopedGraph retains graph edges for snapshot and project files and createDependencyGraph resolves snapshot-relative imports.
+// Technical description: exercises scopedGraph with role=reviewer and createDependencyGraph.resolve with a .forge/runtime/tickets/ticket-verification snapshot path.
+async function verifyReviewerSnapshotGraphAndResolution() {
+  const { scopedGraph } = await import("../../src/tools/discovery/agent-file-index-view.js");
+  const { createDependencyGraph } = await import("../../src/modules/index/dependency-graph.js");
+  const snapshotFile = ".forge/runtime/tickets/ticket-verification/PLAN-TEST/snapshot/0123456789abcdef0123456789abcdef01234567/backend/scripts/control-api-project-runtime.mjs";
+  const targetFile = "backend/src/modules/index/embedding-worker.js";
+  const graph = {
+    imports: [{ path: targetFile, name: "createEmbeddingWorker", kind: "named", broken: false }],
+    imported_by: [{ path: "backend/scripts/start-control-api.mjs", name: "startControlApiWorkers", kind: "named", broken: false }],
+    calls: [{ caller: { path: snapshotFile, name: "startControlApiWorkers" }, target: { path: targetFile, name: "createEmbeddingWorker" }, line: 45 }]
+  };
+  const filtered = scopedGraph(graph, { agent_identity: { role: "reviewer" } });
+  assert.equal(filtered.imports.length, 1);
+  assert.equal(filtered.imported_by.length, 1);
+  assert.equal(filtered.calls.length, 1);
+
+  const depGraph = createDependencyGraph({
+    database: { run() {} },
+    files: { findByPath: (path) => (path === targetFile ? { file_id: "FILE-EMBED-WORKER" } : null) },
+    projectRoot: "/repo"
+  });
+  assert.equal(depGraph.resolve(snapshotFile, "../src/modules/index/embedding-worker.js", false), "FILE-EMBED-WORKER");
+}
+
+test("preserves Reviewer code_graph links and resolves snapshot relative imports", verifyReviewerSnapshotGraphAndResolution);
 
 test("extracts JSX UI metadata symbols for .jsx files but not plain .js", () => {
   const source = `export function Panel({ open }) {
```
