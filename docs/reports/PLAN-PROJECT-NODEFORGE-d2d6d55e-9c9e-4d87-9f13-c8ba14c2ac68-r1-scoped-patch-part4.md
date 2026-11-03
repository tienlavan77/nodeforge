# Scoped Unified Git Diff (Part 4 of 5) — PLAN-PROJECT-NODEFORGE-d2d6d55e-9c9e-4d87-9f13-c8ba14c2ac68 (r1)

- **Base Commit SHA**: `e135298283064f177481325dbb2dccea298d94b7` (`tree_sha: 969aebda64fd8a2cfa0f7a3509219ae9b2a5f2ef`)
- **Review / Implementation Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Files in Part 4**:
  9a. `backend/tests/integration/watcher-embedding-worker-separation.test.js` (diff lines 1–150)

```diff
diff --git a/backend/tests/integration/watcher-embedding-worker-separation.test.js b/backend/tests/integration/watcher-embedding-worker-separation.test.js
new file mode 100644
index 0000000..c6d72e6
--- /dev/null
+++ b/backend/tests/integration/watcher-embedding-worker-separation.test.js
@@ -0,0 +1,290 @@
+// Verifies the separation of Watcher Worker and Embedding Worker lifecycles, summary push/wake delivery, race-condition superseding, and fault isolation in the API runtime (O1, O2, O3).
+// Business purpose: guarantees that file watching and code indexing in the API runtime never block on slow or failing vector calculations, while extracted symbol purpose summaries immediately wake the Embedding Worker to publish atomic vectors.
+// Technical description: exercises `startProjectRuntime` with independent Watcher Worker and Embedding Worker instances under normal operation, slow/blocked embedding barriers, rapid file modifications, provider failures, SSE progress observation, and full teardown.
+import assert from "node:assert/strict";
+import { EventEmitter } from "node:events";
+import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import test from "node:test";
+import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";
+import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
+
+// Polls a condition until it becomes truthy or rejects when the timeout expires so asynchronous worker assertions remain deterministic.
+async function waitFor(predicate, message = "Condition did not settle in time.", timeoutMs = 4000) {
+  const deadline = Date.now() + timeoutMs;
+  while (Date.now() < deadline) {
+    const value = await predicate();
+    if (value) return value;
+    await new Promise((resolve) => setTimeout(resolve, 15));
+  }
+  assert.fail(message);
+}
+
+// Creates a temporary project directory with an initial documented source file and controllable mock filesystem watcher for runtime worker tests.
+async function createProjectFixture(prefix = "nf-worker-sep-") {
+  const baseDir = await mkdtemp(join(tmpdir(), prefix));
+  const projectRoot = join(baseDir, "project");
+  await mkdir(projectRoot, { recursive: true });
+  await writeFile(
+    join(projectRoot, "orders.js"),
+    "// Order processing module for customer checkout.\n\n// Validates and records a customer order in the ledger.\nexport function processOrder(id) {\n  return { id, status: \"recorded\" };\n}\n",
+    "utf8"
+  );
+  let rawWatcher = null;
+  let watcherClosed = 0;
+  // Creates an in-memory EventEmitter watcher that records teardown and immediately signals readiness.
+  function watcherFactory() {
+    const watcher = new EventEmitter();
+    // Tracks explicit watcher teardown calls when the project runtime closes.
+    watcher.close = async () => {
+      watcherClosed += 1;
+    };
+    rawWatcher = watcher;
+    setImmediate(() => watcher.emit("ready"));
+    return watcher;
+  }
+  return {
+    baseDir,
+    projectRoot,
+    watcherFactory,
+    // Returns the active raw watcher emitter so tests can trigger incremental file events.
+    getWatcher: () => rawWatcher,
+    // Returns the number of times the watcher was closed during runtime teardown.
+    getWatcherClosedCount: () => watcherClosed
+  };
+}
+
+test("O1 & O2: Watcher Worker and Embedding Worker run independently, push summaries with immediate wake, and supersede stale updates", async (t) => {
+  const fixture = await createProjectFixture();
+  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
+
+  const embeddedInputs = [];
+  let providerClosed = 0;
+  let blockEmbed = false;
+  let releaseEmbed = null;
+  let embedEnteredResolve = null;
+
+  const runtime = await startProjectRuntime({
+    projectRoot: fixture.projectRoot,
+    projectId: "PROJECT-sep-o1-o2",
+    watcherFactory: fixture.watcherFactory,
+    normalizeComments: false,
+    embeddingPollMs: 60000,
+    logger: { error() {}, warn() {}, info() {}, debug() {} },
+    embeddingProvider: {
+      // Computes a deterministic vector while allowing the test to pause in-flight embedding work.
+      async embed(content) {
+        embeddedInputs.push(content);
+        if (blockEmbed) {
+          embedEnteredResolve?.(content);
+          await new Promise((resolve) => { releaseEmbed = resolve; });
+        }
+        return [1, 0, 0];
+      },
+      // Records embedding provider teardown when the runtime closes.
+      async close() {
+        providerClosed += 1;
+      }
+    }
+  });
+
+  try {
+    assert.ok(runtime.watch, "Expected independent Watcher Worker handle on runtime");
+    assert.ok(runtime.worker, "Expected independent Embedding Worker handle on runtime");
+    assert.equal(runtime.status().readiness, "ready");
+    assert.equal(runtime.status().progress.embedding.succeeded, 1);
+
+    // 1. Verify that pushing a new file summary immediately wakes the Embedding Worker even with a 60s poll interval.
+    await writeFile(
+      join(fixture.projectRoot, "payments.js"),
+      "// Payment settlement module.\n\n// Captures authorized payment funds for an invoice.\nexport function capturePayment(amount) {\n  return { amount, settled: true };\n}\n",
+      "utf8"
+    );
+    fixture.getWatcher().emit("add", join(fixture.projectRoot, "payments.js"));
+
+    await waitFor(
+      () => runtime.database.all("SELECT s.name, e.content_checksum FROM symbols s JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id WHERE s.name = 'capturePayment'").length === 1,
+      "Expected capturePayment summary to wake Embedding Worker and persist vector without waiting for 60s poll"
+    );
+
+    // 2. Verify that Watcher Worker is not blocked while Embedding Worker is paused on an in-flight vector, and rapid updates supersede stale summaries.
+    blockEmbed = true;
+    const firstSummary = "Calculates shipping rates for domestic parcels.";
+    const secondSummary = "Calculates international and domestic shipping rates with customs duties.";
+    const embedEntered = new Promise((resolve) => { embedEnteredResolve = resolve; });
+
+    await writeFile(
+      join(fixture.projectRoot, "orders.js"),
+      `// Order processing module.\n\n// ${firstSummary}\nexport function processOrder(id) {\n  return { id, version: 1 };\n}\n`,
+      "utf8"
+    );
+    fixture.getWatcher().emit("change", join(fixture.projectRoot, "orders.js"));
+
+    await embedEntered;
+    const inFlightStatus = runtime.status();
+    assert.equal(inFlightStatus.progress.embedding.processing, 1, "Expected claimed in-flight job to report processing: 1 while paused");
+    assert.equal(inFlightStatus.progress.embedding.status, "running");
+
+    // While Embedding Worker is blocked on firstSummary, Watcher Worker must still index a second update to orders.js immediately.
+    await writeFile(
+      join(fixture.projectRoot, "orders.js"),
+      `// Order processing module.\n\n// ${secondSummary}\nexport function processOrder(id) {\n  return { id, version: 2 };\n}\n`,
+      "utf8"
+    );
+    fixture.getWatcher().emit("change", join(fixture.projectRoot, "orders.js"));
+
+    await waitFor(
+      () => runtime.database.all("SELECT summary FROM symbols WHERE name = 'processOrder'")[0]?.summary === secondSummary,
+      "Expected Watcher Worker to index the second file modification while Embedding Worker was still busy"
+    );
+
+    blockEmbed = false;
+    releaseEmbed?.();
+
```
