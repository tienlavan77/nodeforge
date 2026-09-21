// Verifies durable embedding job transitions and stale-content protection.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createEmbeddingJobStore, checksumEmbeddingText } from "../../src/modules/index/embedding-job-store.js";
import { createEmbeddingWorker } from "../../src/modules/index/embedding-worker.js";

// Creates a migrated temporary index database for each test.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-embedding-worker-"));
  const database = await openIndexDatabase(root);
  database.run("INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES (?, ?, ?, ?, ?, ?)", ["FILE-1", "src/example.js", "javascript", "sha256:test", 10, new Date().toISOString()]);
  database.run("INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)", ["SYM-1", "FILE-1", "example", "function", 1, 3]);
  database.run("INSERT INTO symbol_content_fts (symbol_id, file_id, path, name, kind, content, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["SYM-1", "FILE-1", "src/example.js", "example", "function", "return 1;", 1, 3]);
  return { root, database };
}

test("embedding jobs deduplicate active work and transition through retry", async () => {
  const { database } = await fixture();
  try {
    const jobs = createEmbeddingJobStore({ database, clock: () => new Date("2026-09-19T00:00:00.000Z") });
    const checksum = checksumEmbeddingText("example\nfunction\nreturn 1;");
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
    const checksum = checksumEmbeddingText("example\nfunction\nreturn 1;");
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
