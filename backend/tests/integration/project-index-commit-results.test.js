// Exercises committed outcomes and failure recovery against real SQLite transactions.
// These scenarios ensure retries cannot mistake parse failures for unchanged content and
// rollback, resolve passes and duplicate events cannot inflate committed attempt counters.
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { indexFixture, quiet } from "./project-index-fixture.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createIndexProgress, indexCheckpoint } from "../../src/modules/index/index-progress.js";

// Preserves old committed data and hashes until a valid replacement commits.
test("failed parsing retains committed rows and hash and retries the same broken source", async (t) => {
  const f = await indexFixture(t);
  await f.write("a.js", "export function before() {}");
  assert.equal((await f.event("a.js", "created")).status, "indexed");
  const before = f.database.all("SELECT * FROM files")[0];
  const checkpoint = indexCheckpoint(f.database);
  await f.write("a.js", "export function broken(");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await f.rebuild();
    assert.equal(result.succeeded, false);
    assert.equal(result.progress.counters.failed, 1);
    assert.equal(result.progress.counters.unchanged, 0);
    assert.equal(result.progress.failures[0].marker, "parse_failed");
    assert.equal(f.database.all("SELECT sha256 FROM files")[0].sha256, before.sha256);
    assert.deepEqual(indexCheckpoint(f.database), checkpoint);
  }
  assert.equal(await f.indexer.handle({ type: "watcher.file_modified", payload: { path: "a.js" } }), false);
  await f.write("a.js", "export function after() {}");
  assert.equal((await f.rebuild()).progress.counters.indexed, 1);
  assert.equal(f.database.all("SELECT name FROM symbols")[0].name, "after");
});

// Verifies committed event identity and resolve work never become duplicate indexing counts.
test("duplicate create, resolve and replayed results do not inflate committed counters", async (t) => {
  const f = await indexFixture(t);
  await f.write("a.js", "function a() {}");
  const committed = await f.event("a.js", "created");
  const version = committed.version;
  assert.equal((await f.event("a.js", "created")).status, "unchanged");
  const resolved = await f.event("a.js", "modified", { phase: "resolve" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.committed, false);
  assert.equal(resolved.version, version);
  const progress = createIndexProgress();
  progress.result(committed); progress.result(committed); progress.result(resolved);
  assert.equal(progress.snapshot().counters.indexed, 1);
  assert.deepEqual(indexCheckpoint(f.database), { version, files: 1, functions: 1 });
  await rm(join(f.root, "a.js"));
  const result = await f.rebuild();
  assert.equal(result.progress.counters.deleted, 1);
  assert.equal(result.progress.checkpoint.files, 0);
  assert.equal((await f.event("a.js", "deleted")).committed, false);
});

// Injects a transactional write fault after source parsing and verifies real database rollback.
test("write rollback and read failure return detailed markers without committed changes", async (t) => {
  const f = await indexFixture(t);
  await f.write("a.js", "function before() {}"); await f.event("a.js", "created");
  const before = indexCheckpoint(f.database);
  await f.write("a.js", "function after() {}");
  const faulty = { ...f.database, run(sql, params) {
    if (sql.startsWith("UPDATE index_metadata")) throw new Error("injected write failure");
    return f.database.run(sql, params);
  } };
  const indexer = createIncrementalIndexer({ database: faulty, projectRoot: f.root, logger: quiet, projectLogger: () => {} });
  const failed = await indexer.handleDetailed({ type: "watcher.file_modified", payload: { path: "a.js" } });
  assert.equal(failed.marker, "write_failed"); assert.equal(failed.committed, false);
  assert.match(failed.message, /injected write failure/);
  assert.deepEqual(indexCheckpoint(f.database), before);
  assert.equal(f.database.all("SELECT name FROM symbols")[0].name, "before");
  const read = await f.event("missing.js");
  assert.equal(read.marker, "read_failed"); assert.equal(read.status, "failed");
  assert.equal((await f.event("a.js")).committed, true);
});

// Force rebuilds retain good index rows if replacement parsing fails.
test("force extraction never clears the prior index on parser failure", async (t) => {
  const f = await indexFixture(t);
  await f.write("a.js", "function keep() {}"); await f.event("a.js", "created");
  const before = indexCheckpoint(f.database);
  await f.write("a.js", "function invalid(");
  const result = await f.rebuild({ force: true });
  assert.equal(result.succeeded, false);
  assert.deepEqual(indexCheckpoint(f.database), before);
});
