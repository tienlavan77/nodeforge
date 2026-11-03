# Scoped Unified Git Diff (Part 5 of 5) — PLAN-PROJECT-NODEFORGE-d2d6d55e-9c9e-4d87-9f13-c8ba14c2ac68 (r1)

- **Base Commit SHA**: `e135298283064f177481325dbb2dccea298d94b7` (`tree_sha: 969aebda64fd8a2cfa0f7a3509219ae9b2a5f2ef`)
- **Review / Implementation Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Files in Part 5**:
  9b. `backend/tests/integration/watcher-embedding-worker-separation.test.js` (diff lines 151–296)

```diff
+    const expectedChecksum = purposeSummaryInput(secondSummary).checksum;
+    await waitFor(
+      () => runtime.database.all("SELECT e.content_checksum FROM symbols s JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id WHERE s.name = 'processOrder'")[0]?.content_checksum === expectedChecksum,
+      "Expected Embedding Worker to supersede the first summary and publish the vector for the latest summary"
+    );
+
+    const supersededCount = runtime.database.all("SELECT COUNT(*) AS count FROM embedding_jobs WHERE status = 'superseded'")[0].count;
+    assert.ok(supersededCount >= 1, "Expected obsolete summary job to be marked superseded");
+  } finally {
+    blockEmbed = false;
+    releaseEmbed?.();
+    await runtime.close();
+  }
+
+  assert.equal(fixture.getWatcherClosedCount(), 1, "Expected Watcher Worker to be closed cleanly");
+  assert.equal(providerClosed, 1, "Expected Embedding Worker provider to be closed cleanly");
+  assert.throws(() => runtime.database.all("SELECT 1"), "Expected index database handle to be closed");
+});
+
+test("O3: Embedding Worker failure is isolated from Watcher Worker indexing and reflected accurately in status and SSE stream", async (t) => {
+  const fixture = await createProjectFixture("nf-worker-fault-");
+  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
+
+  let shouldFailEmbedding = true;
+  const failedEvents = [];
+  const sseFrames = [];
+
+  const runtime = await startProjectRuntime({
+    projectRoot: fixture.projectRoot,
+    projectId: "PROJECT-sep-o3",
+    watcherFactory: fixture.watcherFactory,
+    normalizeComments: false,
+    embeddingPollMs: 60000,
+    logger: { error() {}, warn() {}, info() {}, debug() {} },
+    embeddingProvider: {
+      // Simulates an unavailable Ollama service that later recovers on retry.
+      async embed() {
+        if (shouldFailEmbedding) throw new Error("Ollama service unreachable");
+        return [0, 1, 0];
+      }
+    }
+  });
+
+  runtime.bus.on("embedding.failed", (event) => failedEvents.push(event));
+
+  // Parses raw SSE frames written to an in-memory response sink into event envelopes.
+  function parseSseChunk(chunk, target) {
+    const dataLine = String(chunk).split("\n").find((line) => line.startsWith("data: "));
+    if (dataLine) target.push(JSON.parse(dataLine.slice(6)));
+  }
+
+  const streamConnection = runtime.connect({
+    requestedProjectId: "PROJECT-sep-o3",
+    response: {
+      // Captures SSE frames emitted by the project stream for observability assertions.
+      write(chunk) {
+        parseSseChunk(chunk, sseFrames);
+      },
+      // No-op end handler for in-memory SSE response sink.
+      end() {}
+    }
+  });
+
+  try {
+    const initialStatus = runtime.status();
+    assert.equal(initialStatus.readiness, "ready", "Expected Watcher Worker readiness to remain ready despite embedding failure");
+    assert.equal(initialStatus.progress.status, "succeeded");
+    assert.equal(initialStatus.progress.embedding.status, "failed");
+    assert.match(String(initialStatus.embeddingError), /Ollama service unreachable/);
+    assert.ok(initialStatus.progress.embedding.pending >= 1, "Expected failed job to be scheduled in retry_wait/pending");
+
+    const initialSnapshot = sseFrames.find((frame) => frame.event_type === "stream.snapshot");
+    assert.ok(initialSnapshot, "Expected SSE stream.snapshot frame on initial connect");
+    assert.equal(initialSnapshot.payload.runtime.readiness, "ready");
+    assert.equal(initialSnapshot.payload.runtime.progress.embedding.status, "failed");
+    assert.match(String(initialSnapshot.payload.runtime.progress.embedding.error), /Ollama service unreachable/);
+
+    // Trigger an incremental file addition while embedding service is still failing.
+    await writeFile(
+      join(fixture.projectRoot, "inventory.js"),
+      "// Inventory tracking module.\n\n// Reserves stock items for an active customer cart.\nexport function reserveStock(sku) {\n  return { sku, reserved: true };\n}\n",
+      "utf8"
+    );
+    fixture.getWatcher().emit("add", join(fixture.projectRoot, "inventory.js"));
+
+    await waitFor(
+      () => runtime.database.all("SELECT name, summary FROM symbols WHERE name = 'reserveStock'").length === 1,
+      "Expected Watcher Worker to index inventory.js normally while Embedding Worker is failing"
+    );
+
+    assert.ok(failedEvents.length >= 1, "Expected embedding.failed event to be emitted on project bus");
+    assert.equal(runtime.status().readiness, "ready");
+    assert.equal(runtime.status().progress.checkpoint.files, 2);
+
+    // Recover the embedding provider: first retry one job while another unresolved failure remains in retry_wait.
+    shouldFailEmbedding = false;
+    const firstRetryJobId = runtime.database.all("SELECT job_id FROM embedding_jobs WHERE status = 'retry_wait' ORDER BY created_at ASC LIMIT 1")[0].job_id;
+    runtime.database.run("UPDATE embedding_jobs SET next_retry_at = '1970-01-01T00:00:00.000Z' WHERE job_id = ?", [firstRetryJobId]);
+    assert.equal(await runtime.worker.runOnce(), true);
+
+    const partialRecoveryStatus = runtime.status();
+    assert.equal(partialRecoveryStatus.progress.embedding.succeeded, 1);
+    assert.equal(partialRecoveryStatus.progress.embedding.status, "failed", "Expected failure reporting to persist while another failed/retry_wait job remains");
+    assert.match(String(partialRecoveryStatus.embeddingError), /Ollama service unreachable/);
+
+    // Now make the remaining retry_wait job eligible, wake the worker, and verify full recovery.
+    runtime.database.run("UPDATE embedding_jobs SET next_retry_at = '1970-01-01T00:00:00.000Z' WHERE status = 'retry_wait'");
+    runtime.worker.notify();
+
+    await waitFor(
+      () => runtime.status().progress.embedding.status === "succeeded" && runtime.status().progress.embedding.succeeded === 2,
+      "Expected Embedding Worker retries to succeed and clear failure status once all jobs complete"
+    );
+
+    const recoveredStatus = runtime.status();
+    assert.equal(recoveredStatus.embeddingError, null, "Expected runtime embeddingError to clear after successful retry");
+    assert.equal(recoveredStatus.progress.embedding.status, "succeeded");
+    assert.equal(recoveredStatus.progress.embedding.error, null);
+    assert.equal(recoveredStatus.progress.embedding.pending, 0);
+    assert.equal(recoveredStatus.progress.embedding.processing, 0);
+    assert.equal(recoveredStatus.progress.embedding.succeeded, 2);
+
+    const recoveryFrames = [];
+    const recoveryStream = runtime.connect({
+      requestedProjectId: "PROJECT-sep-o3",
+      response: {
+        // Captures post-recovery SSE frames to verify snapshot health state after retry succeeds.
+        write(chunk) {
+          parseSseChunk(chunk, recoveryFrames);
+        },
+        // No-op end handler for post-recovery SSE response sink.
+        end() {}
+      }
+    });
+    recoveryStream.close();
+
+    const recoveredSnapshot = recoveryFrames.find((frame) => frame.event_type === "stream.snapshot");
+    assert.ok(recoveredSnapshot, "Expected SSE stream.snapshot frame after recovery");
+    assert.equal(recoveredSnapshot.payload.runtime.progress.embedding.status, "succeeded");
+    assert.equal(recoveredSnapshot.payload.runtime.progress.embedding.error, null);
+    assert.equal(recoveredSnapshot.payload.runtime.progress.embedding.succeeded, 2);
+  } finally {
+    streamConnection.close();
+    await runtime.close();
+  }
+});
```
