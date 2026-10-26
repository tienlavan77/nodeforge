// Provides real SQLite indexing and embedding fixtures for incremental summary
// acceptance tests, with controllable source snapshots and provider requests.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createEmbeddingJobStore } from "../../src/modules/index/embedding-job-store.js";
import { createEmbeddingStore } from "../../src/modules/index/embedding-store.js";
import { createEmbeddingWorker } from "../../src/modules/index/embedding-worker.js";

// Creates isolated migrated storage and exercises production indexing through
// watcher events rather than replacing reconciliation with test doubles.
export async function summaryFixture(t, initial, path = "orders.js") {
  const root = await mkdtemp(join(tmpdir(), "purpose-incremental-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await openIndexDatabase(root);
  t.after(() => database.close());
  let content = initial;
  const jobs = createEmbeddingJobStore({ database });
  const store = createEmbeddingStore({ database });
  const inputs = [];
  const provider = { embed: async (summary) => { inputs.push(summary); return [1, 0]; } };
  const worker = createEmbeddingWorker({ database, jobs, embeddingStore: store, embeddingProvider: provider, model: "test-model" });
  const indexer = createIncrementalIndexer({
    database, projectRoot: root, embeddingJobs: jobs, embeddingStore: store, embeddingModel: "test-model",
    projectLogger: () => {}, logger: { warn() {}, warning() {} },
    fileService: { readForIndex: async () => ({ content, sha256: createHash("sha256").update(content).digest("hex"), size_bytes: Buffer.byteLength(content) }) }
  });
  await indexer.handle({ type: "watcher.file_created", payload: { path } });
  return {
    database, jobs, store, provider, worker, inputs, indexer, path,
    // Applies a new source snapshot through the production incremental path.
    async edit(source, type = "watcher.file_modified") {
      content = source;
      await indexer.handle({ type, payload: { path } });
      await Promise.resolve();
    },
    // Drains durable work to make vector preservation and rescheduling observable.
    async drain() { while (await worker.runOnce()) { /* Drain ready work. */ } },
    // Reads persisted identities and coordinates for structural acceptance checks.
    symbols() { return database.all("SELECT * FROM symbols ORDER BY start_line, name"); }
  };
}
