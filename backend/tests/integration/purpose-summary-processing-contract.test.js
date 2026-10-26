// Exercises summary processing with real SQLite, the indexer writer, durable jobs,
// startup reconciliation and the existing backfill executable. Source search retains code.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";
import { createEmbeddingJobStore, checksumEmbeddingText } from "../../src/modules/index/embedding-job-store.js";
import { createEmbeddingWorker } from "../../src/modules/index/embedding-worker.js";
import { createEmbeddingStore } from "../../src/modules/index/embedding-store.js";
import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";

// Creates migrated storage and real source so reconciliation can preserve unchanged records.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "purpose-processing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const summary = "Protect complete customer obligations. ".repeat(200) + "FINAL WARNING.";
  const source = "// File purpose.\n\n// " + summary + "\nfunction save() { return 'IMPLEMENTATION'; }\nfunction missing() {}";
  await writeFile(join(root, "orders.js"), source);
  const database = await openIndexDatabase(root, { runtimeDir: ".forge/runtime/wc" });
  t.after(() => database.close());
  database.run("INSERT INTO files (file_id, path, indexed_at, sha256, size_bytes) VALUES ('f', 'orders.js', 'today', ?, ?)", [createHash("sha256").update(source).digest("hex"), Buffer.byteLength(source)]);
  database.run("INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES ('s', 'f', 'save', 'function', 4, 4), ('missing', 'f', 'missing', 'function', 5, 5)");
  return { root, database, source, summary };
}

// Supplies production writer dependencies while allowing each test to choose queued or direct processing.
function writer(database, extra = {}) {
  return createIndexRecordWriter({ database, logger: console, embeddingModel: "same-model", ...extra });
}

test("indexer scheduling and worker share complete stored O1 input and reject legacy jobs", async (t) => {
  const { database, source, summary } = await fixture(t);
  const jobs = createEmbeddingJobStore({ database });
  writer(database, { embeddingJobs: jobs }).indexContent("f", "orders.js", source);
  await Promise.resolve();
  const expected = purposeSummaryInput(summary);
  assert.equal(database.all("SELECT summary FROM symbols WHERE symbol_id = 's'")[0].summary, summary);
  assert.equal(database.all("SELECT * FROM embedding_jobs").length, 1);
  assert.equal(database.all("SELECT * FROM embedding_jobs")[0].content_checksum, expected.checksum);
  const inputs = [];
  const worker = createEmbeddingWorker({ database, jobs, model: "same-model",
    embeddingStore: createEmbeddingStore({ database }),
    embeddingProvider: { embed: async (content) => { inputs.push(content); return [1, 0]; } } });
  await worker.runOnce();
  assert.deepEqual(inputs, [summary]);
  assert.equal(jobs.counts().completed, 1);
  assert.equal(database.all("SELECT content_checksum FROM symbol_embeddings")[0].content_checksum, expected.checksum);
  assert.match(database.all("SELECT content FROM symbol_content_fts WHERE symbol_id = 's'")[0].content, /IMPLEMENTATION/);
  jobs.enqueue({ symbolId: "s", model: "same-model", contentChecksum: checksumEmbeddingText("save\nfunction\n" + summary) });
  jobs.enqueue({ symbolId: "missing", model: "same-model", contentChecksum: "legacy" });
  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(inputs, [summary]);
  assert.equal(jobs.counts().superseded, 2);
});

test("direct processing replaces legacy vectors and records complete input without metadata", async (t) => {
  const { database, source, summary } = await fixture(t);
  const store = createEmbeddingStore({ database });
  store.upsert({ symbolId: "s", vector: [0, 1], model: "same-model", checksum: "djb2:legacy" });
  const inputs = [];
  writer(database, { embeddingStore: store, embeddingProvider: { embed: async (content) => { inputs.push(content); return [1, 0]; } } }).indexContent("f", "orders.js", source);
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(inputs, [summary]);
  assert.equal(database.all("SELECT content_checksum FROM symbol_embeddings")[0].content_checksum, purposeSummaryInput(summary).checksum);
});

test("worker retains full summary and exposes failed input through durable status", async (t) => {
  const { database, source, summary } = await fixture(t);
  const jobs = createEmbeddingJobStore({ database });
  writer(database, { embeddingJobs: jobs }).indexContent("f", "orders.js", source);
  await Promise.resolve();
  const worker = createEmbeddingWorker({ database, jobs, model: "same-model", maxAttempts: 1,
    embeddingStore: createEmbeddingStore({ database }),
    embeddingProvider: { embed: async (content) => { assert.equal(content, summary); throw new Error("input rejected"); } } });
  await worker.runOnce();
  assert.equal(jobs.counts().failed, 1);
  assert.match(database.all("SELECT last_error FROM embedding_jobs")[0].last_error, /input rejected/);
  assert.equal(database.all("SELECT summary FROM symbols WHERE symbol_id = 's'")[0].summary, summary);
  assert.equal(database.all("SELECT * FROM symbol_embeddings").length, 0);
});

test("startup reconciles old contract vectors for an unchanged model", async (t) => {
  const { root, database, source, summary } = await fixture(t);
  writer(database).indexContent("f", "orders.js", source);
  createEmbeddingStore({ database }).upsert({ symbolId: "s", vector: [0, 1], model: "same-model", checksum: "djb2:legacy" });
  const inputs = [];
  const runtime = await startProjectRuntime({ projectRoot: root, projectId: "purpose-test",
    ollamaConfig: { model: "same-model" },
    embeddingProvider: { embed: async (content) => { inputs.push(content); return [1, 0]; } },
    // Provides watcher lifecycle events while real startup reconciliation reads the project.
    watcherFactory() { const watcher = new EventEmitter(); watcher.close = async () => {}; queueMicrotask(() => watcher.emit("ready")); return watcher; }
  });
  try {
    const deadline = Date.now() + 5000;
    while (!inputs.length && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.ok(inputs.length > 0);
    assert.ok(inputs.every((content) => content === summary));
    assert.deepEqual(runtime.database.all("SELECT symbol_id, content_checksum FROM symbol_embeddings"), [{ symbol_id: "s", content_checksum: purposeSummaryInput(summary).checksum }]);
  } finally { await runtime.close(); }
});

test("backfill sends full stored summaries, invalidates legacy vectors and reports missing summaries", async (t) => {
  const { root, database, source, summary } = await fixture(t);
  writer(database).indexContent("f", "orders.js", source);
  createEmbeddingStore({ database }).upsert({ symbolId: "s", vector: [0, 1], model: "same-model", checksum: "djb2:legacy" });
  const inputs = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    inputs.push(payload);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ embeddings: [[1, 0]] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const output = await new Promise((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [resolve("backend/scripts/backfill-symbol-embeddings.mjs"), "--model=same-model", "--retries=0"], {
        cwd: root, env: { ...process.env, OLLAMA_BASE_URL: "http://127.0.0.1:" + server.address().port }
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", rejectChild);
      child.on("close", (code) => code === 0 ? resolveChild(output) : rejectChild(new Error(output)));
    });
    assert.deepEqual(inputs, [{ model: "same-model", input: summary, truncate: false }]);
    assert.match(output, /Purpose summary missing/);
    assert.equal(database.all("SELECT content_checksum FROM symbol_embeddings")[0].content_checksum, purposeSummaryInput(summary).checksum);
  } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
});
