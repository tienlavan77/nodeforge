/**
 * Verifies local embedding contracts and model-upgrade safety using deterministic
 * inference and real SQLite. These tests prove application wiring and preservation,
 * not availability or compatibility of downloaded production ONNX weights.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createEmbeddingStore } from "../../src/modules/index/embedding-store.js";
import { createEmbeddingJobStore } from "../../src/modules/index/embedding-job-store.js";
import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";
import { createOnnxEmbeddingProvider, ONNX_EMBEDDING_MODEL, ONNX_MODEL_CACHE } from "../../src/modules/index/onnx-embedding-provider.js";
import { startControlApiWorkers } from "../../scripts/control-api-project-runtime.mjs";

/** Confirms concurrent projects share initialization and produce correctly prefixed normalized vectors. */
async function verifyProvider() {
  let loads = 0;
  let initializations = 0;
  const inputs = [];
  /** Models an asynchronously loaded library without downloading inference assets. */
  async function load() {
    loads += 1;
    return {
      /** Records model and cache configuration and supplies deterministic tensor data. */
      async pipeline(task, model, options) {
        initializations += 1;
        assert.equal(task, "feature-extraction");
        assert.equal(model, ONNX_EMBEDDING_MODEL);
        assert.equal(options.cache_dir, ONNX_MODEL_CACHE);
        assert.equal(options.quantized, true);
        /** Records task prefixes and returns an unnormalized vector to test boundary normalization. */
        async function extract(text, settings) {
          inputs.push(text);
          assert.deepEqual(settings, { pooling: "mean", normalize: true });
          return { data: Float32Array.from({ length: 768 }, () => 2) };
        }
        return extract;
      }
    };
  }
  const first = createOnnxEmbeddingProvider({ load });
  const second = createOnnxEmbeddingProvider({ load });
  const vectors = await Promise.all([first.embed("Protect orders."), second.embed("orders", { purpose: "query" })]);
  assert.equal(loads, 1);
  assert.equal(initializations, 1);
  assert.deepEqual(inputs, ["search_document: Protect orders.", "search_query: orders"]);
  for (const vector of vectors) {
    assert.equal(vector.length, 768);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6);
  }
  await assert.rejects(first.embed(" "), /nonempty/);
}

/** Confirms a failed first download can be retried through the same singleton loader. */
async function verifyRetry() {
  let attempts = 0;
  /** Fails once to model a temporary download outage, then supplies valid tensor output. */
  async function load() {
    attempts += 1;
    if (attempts === 1) throw new Error("download unavailable");
    return { pipeline: async () => async () => ({ data: new Float32Array(768).fill(1) }) };
  }
  const provider = createOnnxEmbeddingProvider({ load });
  await assert.rejects(provider.embed("summary"), /download unavailable/);
  assert.equal((await provider.embed("summary")).length, 768);
  assert.equal(attempts, 2);
}

/**
 * Starts the real Control API worker against a legacy SQLite fixture, verifies
 * automatic backfill without watcher events, checks source preservation and a
 * second startup retaining current vectors, and exposes progress through status.
 */
async function verifyStartup(context) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-onnx-startup-"));
  const database = await openIndexDatabase(root);
  let workers;
  context.after(async () => {
    await workers?.stop();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  database.run("INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES ('F', 'orders.js', 'javascript', 'sha256:test', 20, ?)", [now]);
  for (const id of ["old", "current", "missing", "empty", "recover"]) {
    database.run("INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line, summary) VALUES (?, 'F', ?, 'function', 1, 3, ?)", [id, id, id === "empty" ? null : "Protect " + id]);
  }
  const files = database.all("SELECT * FROM files");
  const symbols = database.all("SELECT * FROM symbols ORDER BY symbol_id");
  const store = createEmbeddingStore({ database });
  const jobs = createEmbeddingJobStore({ database });
  store.upsert({ symbolId: "old", vector: [1, 0], model: "embeddinggemma", checksum: "old" });
  store.upsert({ symbolId: "current", vector: [1, 0], model: ONNX_EMBEDDING_MODEL, checksum: purposeSummaryInput("Protect current").checksum });
  const preserved = database.all("SELECT * FROM symbol_embeddings WHERE symbol_id = 'current'");
  for (const model of ["all-minilm", "embeddinggemma"]) {
    jobs.enqueue({ symbolId: "old", contentChecksum: "legacy", model });
  }
  jobs.enqueue({ symbolId: "recover", contentChecksum: purposeSummaryInput("Protect recover").checksum, model: ONNX_EMBEDDING_MODEL });
  database.run("UPDATE embedding_jobs SET status = 'processing' WHERE symbol_id = 'recover'");
  const inputs = [];
  /** Uses a fixed model identity so lifecycle tests exercise production queue discrimination. */
  const provider = {
    model: ONNX_EMBEDDING_MODEL,
    /** Records summary input and produces deterministic storage-compatible vectors. */
    async embed(text) { inputs.push(text); return [1, 0]; }
  };
  /** Supplies a watcher without initial events to prove startup alone triggers backfill. */
  function watcherFactory() {
    const watcher = new EventEmitter();
    watcher.close = async () => {};
    return watcher;
  }
  const options = { projectRoot: root, projectId: "P", indexDb: database, embeddingProvider: provider,
    watcherFactory, runVerification: false, pollMs: 5,
    runtimeLogger: { info() {}, error() {} } };
  workers = startControlApiWorkers(options);
  for (let attempt = 0; attempt < 200 && inputs.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = workers.status();
  assert.equal(snapshot.progress.embedding.pending, 0);
  assert.equal(snapshot.progress.embedding.processing, 0);
  assert.equal(snapshot.progress.embedding.succeeded, 3);
  assert.equal(snapshot.progress.embedding.failed, 0);
  assert.equal(snapshot.readiness, "ready");
  assert.deepEqual(inputs.sort(), ["Protect missing", "Protect old", "Protect recover"]);
  assert.equal(database.all("SELECT * FROM embedding_jobs WHERE model != ?", [ONNX_EMBEDDING_MODEL]).length, 0);
  assert.deepEqual(database.all("SELECT * FROM files"), files);
  assert.deepEqual(database.all("SELECT * FROM symbols ORDER BY symbol_id"), symbols);
  assert.deepEqual(database.all("SELECT * FROM symbol_embeddings WHERE symbol_id = 'current'"), preserved);
  assert.equal(database.all("SELECT * FROM symbol_embeddings").length, 4);
  assert.throws(() => store.removeOtherModels(""), /model tag/);
  assert.throws(() => jobs.removeOtherModels(" "), /model tag/);
  await workers.stop();
  workers = startControlApiWorkers(options);
  assert.equal(workers.status().progress.embedding.pending, 0);
  assert.equal(inputs.length, 3);
  assert.deepEqual(database.all("SELECT * FROM symbol_embeddings WHERE symbol_id = 'current'"), preserved);
}

test("ONNX providers share lazy quantized pipeline and normalize document/query vectors", verifyProvider);
test("ONNX singleton initialization retries after download failure", verifyRetry);
test("Control API upgrades legacy embeddings, preserves summaries, and resumes automatically", verifyStartup);
