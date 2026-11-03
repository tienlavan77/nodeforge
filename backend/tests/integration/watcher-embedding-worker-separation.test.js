// Verifies the separation of Watcher Worker and Embedding Worker lifecycles, summary push/wake delivery, race-condition superseding, and fault isolation in the API runtime (O1, O2, O3).
// Business purpose: guarantees that file watching and code indexing in the API runtime never block on slow or failing vector calculations, while extracted symbol purpose summaries immediately wake the Embedding Worker to publish atomic vectors.
// Technical description: exercises `startProjectRuntime` with independent Watcher Worker and Embedding Worker instances under normal operation, slow/blocked embedding barriers, rapid file modifications, provider failures, SSE progress observation, and full teardown.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";

// Polls a condition until it becomes truthy or rejects when the timeout expires so asynchronous worker assertions remain deterministic.
async function waitFor(predicate, message = "Condition did not settle in time.", timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

// Creates a temporary project directory with an initial documented source file and controllable mock filesystem watcher for runtime worker tests.
async function createProjectFixture(prefix = "nf-worker-sep-") {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(baseDir, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "orders.js"),
    "// Order processing module for customer checkout.\n\n// Validates and records a customer order in the ledger.\nexport function processOrder(id) {\n  return { id, status: \"recorded\" };\n}\n",
    "utf8"
  );
  let rawWatcher = null;
  let watcherClosed = 0;
  // Creates an in-memory EventEmitter watcher that records teardown and immediately signals readiness.
  function watcherFactory() {
    const watcher = new EventEmitter();
    // Tracks explicit watcher teardown calls when the project runtime closes.
    watcher.close = async () => {
      watcherClosed += 1;
    };
    rawWatcher = watcher;
    setImmediate(() => watcher.emit("ready"));
    return watcher;
  }
  return {
    baseDir,
    projectRoot,
    watcherFactory,
    // Returns the active raw watcher emitter so tests can trigger incremental file events.
    getWatcher: () => rawWatcher,
    // Returns the number of times the watcher was closed during runtime teardown.
    getWatcherClosedCount: () => watcherClosed
  };
}

test("O1 & O2: Watcher Worker and Embedding Worker run independently, push summaries with immediate wake, and supersede stale updates", async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));

  const embeddedInputs = [];
  let providerClosed = 0;
  let blockEmbed = false;
  let releaseEmbed = null;
  let embedEnteredResolve = null;

  const runtime = await startProjectRuntime({
    projectRoot: fixture.projectRoot,
    projectId: "PROJECT-sep-o1-o2",
    watcherFactory: fixture.watcherFactory,
    normalizeComments: false,
    embeddingPollMs: 60000,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    embeddingProvider: {
      // Computes a deterministic vector while allowing the test to pause in-flight embedding work.
      async embed(content) {
        embeddedInputs.push(content);
        if (blockEmbed) {
          embedEnteredResolve?.(content);
          await new Promise((resolve) => { releaseEmbed = resolve; });
        }
        return [1, 0, 0];
      },
      // Records embedding provider teardown when the runtime closes.
      async close() {
        providerClosed += 1;
      }
    }
  });

  try {
    assert.ok(runtime.watch, "Expected independent Watcher Worker handle on runtime");
    assert.ok(runtime.worker, "Expected independent Embedding Worker handle on runtime");
    assert.equal(runtime.status().readiness, "ready");
    await waitFor(() => runtime.status().progress.embedding.succeeded === 1, "Expected initial symbol embedding to complete in background");
    assert.equal(runtime.status().progress.embedding.succeeded, 1);

    // 1. Verify that pushing a new file summary immediately wakes the Embedding Worker even with a 60s poll interval.
    await writeFile(
      join(fixture.projectRoot, "payments.js"),
      "// Payment settlement module.\n\n// Captures authorized payment funds for an invoice.\nexport function capturePayment(amount) {\n  return { amount, settled: true };\n}\n",
      "utf8"
    );
    fixture.getWatcher().emit("add", join(fixture.projectRoot, "payments.js"));

    await waitFor(
      () => runtime.database.all("SELECT s.name, e.content_checksum FROM symbols s JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id WHERE s.name = 'capturePayment'").length === 1,
      "Expected capturePayment summary to wake Embedding Worker and persist vector without waiting for 60s poll"
    );

    // 2. Verify that Watcher Worker is not blocked while Embedding Worker is paused on an in-flight vector, and rapid updates supersede stale summaries.
    blockEmbed = true;
    const firstSummary = "Calculates shipping rates for domestic parcels.";
    const secondSummary = "Calculates international and domestic shipping rates with customs duties.";
    const embedEntered = new Promise((resolve) => { embedEnteredResolve = resolve; });

    await writeFile(
      join(fixture.projectRoot, "orders.js"),
      `// Order processing module.\n\n// ${firstSummary}\nexport function processOrder(id) {\n  return { id, version: 1 };\n}\n`,
      "utf8"
    );
    fixture.getWatcher().emit("change", join(fixture.projectRoot, "orders.js"));

    await embedEntered;
    const inFlightStatus = runtime.status();
    assert.equal(inFlightStatus.progress.embedding.processing, 1, "Expected claimed in-flight job to report processing: 1 while paused");
    assert.equal(inFlightStatus.progress.embedding.status, "running");

    // While Embedding Worker is blocked on firstSummary, Watcher Worker must still index a second update to orders.js immediately.
    await writeFile(
      join(fixture.projectRoot, "orders.js"),
      `// Order processing module.\n\n// ${secondSummary}\nexport function processOrder(id) {\n  return { id, version: 2 };\n}\n`,
      "utf8"
    );
    fixture.getWatcher().emit("change", join(fixture.projectRoot, "orders.js"));

    await waitFor(
      () => runtime.database.all("SELECT summary FROM symbols WHERE name = 'processOrder'")[0]?.summary === secondSummary,
      "Expected Watcher Worker to index the second file modification while Embedding Worker was still busy"
    );

    blockEmbed = false;
    releaseEmbed?.();

    const expectedChecksum = purposeSummaryInput(secondSummary).checksum;
    await waitFor(
      () => runtime.database.all("SELECT e.content_checksum FROM symbols s JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id WHERE s.name = 'processOrder'")[0]?.content_checksum === expectedChecksum,
      "Expected Embedding Worker to supersede the first summary and publish the vector for the latest summary"
    );

    const supersededCount = runtime.database.all("SELECT COUNT(*) AS count FROM embedding_jobs WHERE status = 'superseded'")[0].count;
    assert.ok(supersededCount >= 1, "Expected obsolete summary job to be marked superseded");
  } finally {
    blockEmbed = false;
    releaseEmbed?.();
    await runtime.close();
  }

  assert.equal(fixture.getWatcherClosedCount(), 1, "Expected Watcher Worker to be closed cleanly");
  assert.equal(providerClosed, 1, "Expected Embedding Worker provider to be closed cleanly");
  assert.throws(() => runtime.database.all("SELECT 1"), "Expected index database handle to be closed");
});

test("O3: Embedding Worker failure is isolated from Watcher Worker indexing and reflected accurately in status and SSE stream", async (t) => {
  const fixture = await createProjectFixture("nf-worker-fault-");
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));

  let shouldFailEmbedding = true;
  const failedEvents = [];
  const sseFrames = [];

  const runtime = await startProjectRuntime({
    projectRoot: fixture.projectRoot,
    projectId: "PROJECT-sep-o3",
    watcherFactory: fixture.watcherFactory,
    normalizeComments: false,
    embeddingPollMs: 60000,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    embeddingProvider: {
      // Simulates an unavailable Ollama service that later recovers on retry.
      async embed() {
        if (shouldFailEmbedding) throw new Error("Ollama service unreachable");
        return [0, 1, 0];
      }
    }
  });

  runtime.bus.on("embedding.failed", (event) => failedEvents.push(event));

  // Parses raw SSE frames written to an in-memory response sink into event envelopes.
  function parseSseChunk(chunk, target) {
    const dataLine = String(chunk).split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) target.push(JSON.parse(dataLine.slice(6)));
  }

  await waitFor(() => runtime.status().progress.embedding.status === "failed", "Expected initial background embedding failure to be recorded");
  const streamConnection = runtime.connect({
    requestedProjectId: "PROJECT-sep-o3",
    response: {
      // Captures SSE frames emitted by the project stream for observability assertions.
      write(chunk) {
        parseSseChunk(chunk, sseFrames);
      },
      // No-op end handler for in-memory SSE response sink.
      end() {}
    }
  });

  try {
    const initialStatus = runtime.status();
    assert.equal(initialStatus.readiness, "ready", "Expected Watcher Worker readiness to remain ready despite embedding failure");
    assert.equal(initialStatus.progress.status, "succeeded");
    assert.equal(initialStatus.progress.embedding.status, "failed");
    assert.match(String(initialStatus.embeddingError), /Ollama service unreachable/);
    assert.ok(initialStatus.progress.embedding.pending >= 1, "Expected failed job to be scheduled in retry_wait/pending");

    const initialSnapshot = sseFrames.find((frame) => frame.event_type === "stream.snapshot");
    assert.ok(initialSnapshot, "Expected SSE stream.snapshot frame on initial connect");
    assert.equal(initialSnapshot.payload.runtime.readiness, "ready");
    assert.equal(initialSnapshot.payload.runtime.progress.embedding.status, "failed");
    assert.match(String(initialSnapshot.payload.runtime.progress.embedding.error), /Ollama service unreachable/);

    // Trigger an incremental file addition while embedding service is still failing.
    await writeFile(
      join(fixture.projectRoot, "inventory.js"),
      "// Inventory tracking module.\n\n// Reserves stock items for an active customer cart.\nexport function reserveStock(sku) {\n  return { sku, reserved: true };\n}\n",
      "utf8"
    );
    fixture.getWatcher().emit("add", join(fixture.projectRoot, "inventory.js"));

    await waitFor(
      () => runtime.database.all("SELECT name, summary FROM symbols WHERE name = 'reserveStock'").length === 1,
      "Expected Watcher Worker to index inventory.js normally while Embedding Worker is failing"
    );

    assert.ok(failedEvents.length >= 1, "Expected embedding.failed event to be emitted on project bus");
    assert.equal(runtime.status().readiness, "ready");
    assert.equal(runtime.status().progress.checkpoint.files, 2);

    // Recover the embedding provider: first retry one job while another unresolved failure remains in retry_wait.
    shouldFailEmbedding = false;
    const firstRetryJobId = runtime.database.all("SELECT job_id FROM embedding_jobs WHERE status = 'retry_wait' ORDER BY created_at ASC LIMIT 1")[0].job_id;
    runtime.database.run("UPDATE embedding_jobs SET next_retry_at = '1970-01-01T00:00:00.000Z' WHERE job_id = ?", [firstRetryJobId]);
    assert.equal(await runtime.worker.runOnce(), true);

    const partialRecoveryStatus = runtime.status();
    assert.equal(partialRecoveryStatus.progress.embedding.succeeded, 1);
    assert.equal(partialRecoveryStatus.progress.embedding.status, "failed", "Expected failure reporting to persist while another failed/retry_wait job remains");
    assert.match(String(partialRecoveryStatus.embeddingError), /Ollama service unreachable/);

    // Now make the remaining retry_wait job eligible, wake the worker, and verify full recovery.
    runtime.database.run("UPDATE embedding_jobs SET next_retry_at = '1970-01-01T00:00:00.000Z' WHERE status = 'retry_wait'");
    runtime.worker.notify();

    await waitFor(
      () => runtime.status().progress.embedding.status === "succeeded" && runtime.status().progress.embedding.succeeded === 2,
      "Expected Embedding Worker retries to succeed and clear failure status once all jobs complete"
    );

    const recoveredStatus = runtime.status();
    assert.equal(recoveredStatus.embeddingError, null, "Expected runtime embeddingError to clear after successful retry");
    assert.equal(recoveredStatus.progress.embedding.status, "succeeded");
    assert.equal(recoveredStatus.progress.embedding.error, null);
    assert.equal(recoveredStatus.progress.embedding.pending, 0);
    assert.equal(recoveredStatus.progress.embedding.processing, 0);
    assert.equal(recoveredStatus.progress.embedding.succeeded, 2);

    const recoveryFrames = [];
    const recoveryStream = runtime.connect({
      requestedProjectId: "PROJECT-sep-o3",
      response: {
        // Captures post-recovery SSE frames to verify snapshot health state after retry succeeds.
        write(chunk) {
          parseSseChunk(chunk, recoveryFrames);
        },
        // No-op end handler for post-recovery SSE response sink.
        end() {}
      }
    });
    recoveryStream.close();

    const recoveredSnapshot = recoveryFrames.find((frame) => frame.event_type === "stream.snapshot");
    assert.ok(recoveredSnapshot, "Expected SSE stream.snapshot frame after recovery");
    assert.equal(recoveredSnapshot.payload.runtime.progress.embedding.status, "succeeded");
    assert.equal(recoveredSnapshot.payload.runtime.progress.embedding.error, null);
    assert.equal(recoveredSnapshot.payload.runtime.progress.embedding.succeeded, 2);
  } finally {
    streamConnection.close();
    await runtime.close();
  }
});
