// Verifies durable embedding job transitions and stale-content protection.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createEmbeddingJobStore } from "../../src/modules/index/embedding-job-store.js";
import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";
import { createEmbeddingWorker } from "../../src/modules/index/embedding-worker.js";

// Creates a migrated temporary index database for each test.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-embedding-worker-"));
  const database = await openIndexDatabase(root);
  database.run("INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES (?, ?, ?, ?, ?, ?)", ["FILE-1", "src/example.js", "javascript", "sha256:test", 10, new Date().toISOString()]);
  database.run("INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)", ["SYM-1", "FILE-1", "example", "function", 1, 3]);
  database.run("INSERT INTO symbol_content_fts (symbol_id, file_id, path, name, kind, content, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["SYM-1", "FILE-1", "src/example.js", "example", "function", "return 1;", 1, 3]);
  database.run("UPDATE symbols SET summary = ?", ["Protect customer orders."]);
  return { root, database };
}

test("embedding jobs deduplicate active work and transition through retry", async () => {
  const { database } = await fixture();
  try {
    const jobs = createEmbeddingJobStore({ database, clock: () => new Date("2026-09-19T00:00:00.000Z") });
    const checksum = purposeSummaryInput("Protect customer orders.").checksum;
    const first = jobs.enqueue({ symbolId: "SYM-1", contentChecksum: checksum, model: "embeddinggemma" });
    const duplicate = jobs.enqueue({ symbolId: "SYM-1", contentChecksum: checksum, model: "embeddinggemma" });
    assert.equal(duplicate.job_id, first.job_id);
    const claimed = jobs.claimNext({ now: "2026-09-19T00:00:00.000Z" });
    assert.equal(claimed.status, "processing");
    jobs.retry(claimed.job_id, new Error("temporary"), { maxAttempts: 3, delayMs: 1000 });
    assert.equal(jobs.counts().retry_wait, 1);
    jobs.complete(claimed.job_id);
    assert.equal(jobs.counts().completed, 1);
  } finally {
    await database.close();
  }
});

test("worker embeds only when the queued checksum is still current", async () => {
  const { database } = await fixture();
  try {
    const jobs = createEmbeddingJobStore({ database, clock: () => new Date("2026-09-19T00:00:00.000Z") });
    const checksum = purposeSummaryInput("Protect customer orders.").checksum;
    jobs.enqueue({ symbolId: "SYM-1", contentChecksum: checksum, model: "embeddinggemma" });
    const vectors = [];
    const worker = createEmbeddingWorker({
      database,
      jobs,
      embeddingStore: { upsert: (value) => vectors.push(value) },
      embeddingProvider: { embed: async () => [1, 2, 3] },
      model: "embeddinggemma",
      clock: () => new Date("2026-09-19T00:00:00.000Z")
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(vectors.length, 1);
    assert.equal(jobs.counts().completed, 1);
  } finally {
    await database.close();
  }
});

test("worker notify wakes an idle polling loop immediately when a summary job is pushed", async () => {
  const { database } = await fixture();
  let worker;
  let loopTask;
  try {
    let settledResolve;
    const settled = new Promise((resolve) => { settledResolve = resolve; });
    const vectors = [];
    const jobs = createEmbeddingJobStore({
      database,
      clock: () => new Date("2026-09-19T00:00:00.000Z"),
      // Wakes the embedding worker immediately when a new symbol summary job is enqueued into SQLite.
      onEnqueue() {
        worker?.notify();
      }
    });
    worker = createEmbeddingWorker({
      database,
      jobs,
      // Stores computed vectors in memory so the unit test can assert immediate publication.
      embeddingStore: { upsert: (value) => vectors.push(value) },
      // Returns a deterministic vector for the enqueued symbol summary input.
      embeddingProvider: { embed: async () => [0.5, 0.5] },
      model: "embeddinggemma",
      clock: () => new Date("2026-09-19T00:00:00.000Z"),
      // Resolves the test promise as soon as the woken worker finishes processing the pushed job.
      onJobSettled(job) {
        settledResolve(job);
      }
    });
    loopTask = worker.start({ pollMs: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const checksum = purposeSummaryInput("Protect customer orders.").checksum;
    jobs.enqueue({ symbolId: "SYM-1", contentChecksum: checksum, model: "embeddinggemma" });
    const processedJob = await settled;
    assert.equal(processedJob.symbol_id, "SYM-1");
    assert.equal(vectors.length, 1);
    assert.equal(jobs.counts().completed, 1);
  } finally {
    worker?.stop();
    await loopTask;
    await database.close();
  }
});
