# Scoped Unified Git Diff (Part 8 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 1086–1240 of 1395

```diff
+          // Records secondary runtime teardown during lifecycle close.
+          async close() { closed = true; teardownOrder.push(`runtime:${input.projectId}`); }
+        };
+      }
+    })
+  });
+  context.after(() => lifecycle.close());
+
+  assert.equal(defaultWorkerPairCount, 1);
+  assert.deepEqual(secondaryStarted, ["PROJECT-SECOND"]);
+  assert.equal(lifecycle.list().length, 2);
+  const admittedDefault = await lifecycle.get(defaultRoot);
+  assert.equal(admittedDefault.watch, fakeDefaultWorkers.watch);
+  assert.equal(admittedDefault.worker, fakeDefaultWorkers.worker);
+
+  const repoRoot = resolve(process.cwd());
+  const signalScript = join(workspace, "signal-api-child.mjs");
+  await writeFile(signalScript, [
+    `import { createServer } from "node:http";`,
+    `import { EventEmitter } from "node:events";`,
+    `import { join } from "node:path";`,
+    `import { createDatabaseService } from ${JSON.stringify(join(repoRoot, "backend/src/infrastructure/sqlite/database-service.js"))};`,
+    `import { startControlApiWorkers } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-project-runtime.mjs"))};`,
+    `import { startControlApi } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-lifecycle.mjs"))};`,
+    `const dataDir = ${JSON.stringify(join(workspace, "signal-child-root"))};`,
+    `const indexDb = await createDatabaseService({ dataDir, runtimeDir: join(".forge", "runtime", "wc") });`,
+    `const rawWatcher = new EventEmitter();`,
+    `rawWatcher.close = async () => { process.stdout.write("STEP:watcher\\n"); };`,
+    `const workers = startControlApiWorkers({`,
+    `  projectRoot: dataDir,`,
+    `  projectId: "PROJECT-SIGNAL",`,
+    `  indexDb,`,
+    `  watcherFactory: () => rawWatcher,`,
+    `  runVerification: false,`,
+    `  pollMs: 50,`,
+    `  ollamaConfig: { host: "http://127.0.0.1:11434", model: "sig-model", timeoutMs: 1000 },`,
+    `  embeddingProvider: { async embed() { return [0.1]; }, async close() { process.stdout.write("STEP:embeddingProvider\\n"); } }`,
+    `});`,
+    `startControlApi({`,
+    `  api: { createServer },`,
+    `  port: 0,`,
+    `  host: "127.0.0.1",`,
+    `  workers: [workers],`,
+    `  indexDb: { close: async () => { process.stdout.write("STEP:indexDb\\n"); await indexDb.close(); } },`,
+    `  controlDb: { close: async () => { process.stdout.write("STEP:controlDb\\n"); } },`,
+    `  processLock: { release: () => { process.stdout.write("STEP:processLock\\n"); } }`,
+    `});`
+  ].join("\n"));
+
+  for (const signal of ["SIGTERM", "SIGINT"]) {
+    const child = spawn(process.execPath, [signalScript], { stdio: ["ignore", "pipe", "pipe"] });
+    let stdout = "";
+    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
+    await waitFor(() => stdout.includes("Node Control API listening on http://127.0.0.1:"));
+    child.kill(signal);
+    const [code] = await once(child, "exit");
+    assert.equal(code, 0, `${signal} exits cleanly with status 0`);
+    const steps = stdout.split("\n").filter((line) => line.startsWith("STEP:")).map((line) => line.slice(5));
+    assert.deepEqual(steps, ["watcher", "embeddingProvider", "indexDb", "controlDb", "processLock"]);
+  }
+
+  await fakeDefaultWorkers.stop();
+  await lifecycle.close();
+  assert.equal(admittedDefault.status().closed, true);
+  assert.deepEqual(teardownOrder, ["defaultWatcher", "defaultEmbeddingWorker", "runtime:PROJECT-SECOND"]);
+}
+
+test("Multi-project lifecycle startup runs only one default-project worker pair and SIGTERM/SIGINT cleanly drain workers before SQLite", verifyMultiProjectAndSignalShutdown);
diff --git a/backend/tests/unit/dev-foreground-view.test.js b/backend/tests/unit/dev-foreground-view.test.js
index 6d540ea..7c3e8af 100644
--- a/backend/tests/unit/dev-foreground-view.test.js
+++ b/backend/tests/unit/dev-foreground-view.test.js
@@ -1,9 +1,15 @@
 // Verifies log scrolling redraws only the viewport content while the command and status positions remain fixed.
 import assert from "node:assert/strict";
 import test from "node:test";
+import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join, resolve } from "node:path";
 import { createForegroundView } from "../../scripts/dev-foreground-view.mjs";
+import { definitions, suggestions, FOREGROUND_STARTUP_MESSAGE, FOREGROUND_HELP_MESSAGE, executeForegroundCommand, createForegroundController } from "../../scripts/dev-foreground.mjs";
 
-test("log scroll preserves fixed status and input rows", () => {
+// Business purpose: verifies that log viewport scrolling keeps the status bar and command input box at fixed terminal rows.
+// Technical description: renders latest, scrolled-back, suggestion-expanded, and copy-mode states and asserts ANSI cursor positioning and viewport lines.
+function verifyForegroundScrollLayout() {
   const chunks = [];
   const output = { rows: 24, columns: 80, write: (chunk) => chunks.push(chunk) };
   const logLines = Array.from({ length: 30 }, (_, index) => ({ name: "SYSTEM", line: `log-${index}` }));
@@ -35,4 +41,161 @@ test("log scroll preserves fixed status and input rows", () => {
   state.copyMode = true;
   render(state);
   assert.deepEqual(chunks, []);
-});
+}
+
+// Business purpose: verifies that dev:foreground supervises only api and ui, renders embedding progress, and rejects /r watcher.
+// Technical description: asserts service definitions, startup/help messages, prompt placeholder rendering, and executeForegroundCommand routing for /r api, /r ui, /r watcher, /copy, /save, and /q.
+async function verifyForegroundServicesAndCommands() {
+  assert.deepEqual(Object.keys(definitions), ["api", "ui"]);
+  assert.equal(FOREGROUND_STARTUP_MESSAGE, "Services starting: api, ui");
+  assert.deepEqual(suggestions, ["/q quit", "/r api restart", "/r ui restart", "/copy", "/save log.txt"]);
+  assert.ok(!suggestions.some((item) => item.includes("watcher")));
+
+  const chunks = [];
+  const output = { rows: 24, columns: 100, write: (chunk) => chunks.push(chunk) };
+  const { render } = createForegroundView({
+    children: new Map(),
+    serviceState: new Map([["api", "running"], ["ui", "running"]]),
+    logLines: [],
+    suggestions,
+    isActive: () => true,
+    output,
+    getGitInfo: () => "main",
+    getEmbeddingProgress: () => "embed ████░░░░░░░░ 33% · 1/3 done · 2 queued · 1 vectors"
+  });
+  render({ input: "", cursor: 0, scrollBack: 0, copyMode: false });
+  const emptyPromptScreen = chunks.join("");
+  assert.ok(emptyPromptScreen.includes("/r api|ui restart"));
+  assert.ok(!emptyPromptScreen.includes("watcher"));
+  assert.ok(emptyPromptScreen.includes("embed ████░░░░░░░░ 33%"));
+
+  const restarted = [];
+  const saved = [];
+  const helpMessages = [];
+  let quitted = 0;
+  let copied = 0;
+  const handlers = {
+    onShutdown: () => { quitted += 1; },
+    onRestart: (service) => { restarted.push(service); },
+    onCopy: () => { copied += 1; },
+    onSave: (target) => { saved.push(target); },
+    onHelp: (msg) => { helpMessages.push(msg); }
+  };
+
+  assert.deepEqual(await executeForegroundCommand("/r api", handlers), { action: "restart", service: "api" });
+  assert.deepEqual(await executeForegroundCommand("/r ui", handlers), { action: "restart", service: "ui" });
+  assert.deepEqual(await executeForegroundCommand("/r watcher", handlers), { action: "help", message: FOREGROUND_HELP_MESSAGE });
+  assert.deepEqual(await executeForegroundCommand("/copy", handlers), { action: "copy" });
+  assert.deepEqual(await executeForegroundCommand("/save custom.log", handlers), { action: "save", path: "custom.log" });
+  assert.deepEqual(await executeForegroundCommand("/q", handlers), { action: "quit" });
+
+  assert.deepEqual(restarted, ["api", "ui"]);
+  assert.deepEqual(saved, ["custom.log"]);
+  assert.equal(copied, 1);
+  assert.equal(quitted, 1);
+  assert.deepEqual(helpMessages, ["Commands: /q quit · /r api|ui restart · /copy select · /save <file>"]);
+}
+
+test("log scroll preserves fixed status and input rows", verifyForegroundScrollLayout);
+test("dev:foreground supervises only api and ui, accepts /r api and /r ui, and rejects /r watcher", verifyForegroundServicesAndCommands);
+
+// Polls an asynchronous assertion condition until it becomes truthy or times out.
+async function waitForCondition(predicate, timeoutMs = 6000, getDebug = () => "") {
+  const deadline = Date.now() + timeoutMs;
```
