// Verifies existing indexes convert unchanged source through production extraction,
// retain graph and raw search rows, and resume safely after read or parse failures.
// No fixture asks the converter to complete historical comments.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { summaryFixture } from "./purpose-summary-fixture.js";
import { backfillPurposeSummaries } from "../../src/modules/index/purpose-summary-backfill.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createSummaryConversion } from "../../src/modules/index/purpose-summary-conversion.js";
import { extractorRegistry } from "../../src/modules/index/parser/index.js";
import { rebuildIndex } from "../../src/modules/index/index-rebuild.js";

const source = "// Orders module.\n\n// Save orders.\nexport function save() { return 123; }";

// Removes only conversion-derived state to simulate an index created before
// summary extraction existed, preserving the exact source checksum and identities.
function legacy(f) {
  f.database.run("DELETE FROM purpose_summary_conversion");
  f.database.run("UPDATE files SET summary = NULL");
  f.database.run("UPDATE symbols SET summary = NULL");
}

test("unchanged-checksum backfill is resumable, idempotent and preserves source and graph", async (t) => {
  const f = await summaryFixture(t, source);
  await f.drain();
  const before = f.symbols();
  const graph = f.database.all("SELECT * FROM imports_exports");
  const raw = f.database.all("SELECT * FROM file_content_fts");
  legacy(f);
  f.store.upsert({ symbolId: before[0].symbol_id, vector: [1, 0], model: "test-model", checksum: "legacy-code" });
  assert.deepEqual(f.store.search([1, 0]), []);
  const options = { database: f.database, projectRoot: ".", indexer: f.indexer };
  const result = await backfillPurposeSummaries(options);
  assert.equal(result.succeeded, true);
  assert.equal(result.results[0].status, "indexed");
  assert.equal(f.symbols()[0].summary, "Save orders.");
  assert.equal(f.symbols()[0].symbol_id, before[0].symbol_id);
  assert.deepEqual(f.database.all("SELECT * FROM imports_exports"), graph);
  assert.deepEqual(f.database.all("SELECT * FROM file_content_fts"), raw);
  assert.deepEqual(f.database.all("SELECT * FROM symbol_embeddings"), []);
  await f.drain();
  const jobs = f.database.all("SELECT * FROM embedding_jobs");
  assert.equal((await backfillPurposeSummaries(options)).results[0].status, "unchanged");
  assert.deepEqual(f.database.all("SELECT * FROM embedding_jobs"), jobs);
  assert.match(f.database.all("SELECT content_checksum FROM symbol_embeddings")[0].content_checksum, /^purpose-summary-v1:/);
});

for (const failure of ["read_failed", "parse_failed"]) {
  test("conversion reports " + failure + " and retries without destroying the prior index", async (t) => {
    const f = await summaryFixture(t, source);
    legacy(f);
    const before = f.symbols();
    let broken = true;
    const indexer = createIncrementalIndexer({
      database: f.database, projectRoot: ".", projectLogger: () => {}, logger: { warning() {}, warn() {} },
      fileService: { readForIndex: async () => {
        if (broken && failure === "read_failed") throw Object.assign(new Error("Unreadable source"), { code: "read_failed" });
        return { content: source, sha256: createHash("sha256").update(source).digest("hex"), size_bytes: source.length };
      } },
      registry: { supports: () => true, extract: (...args) => {
        if (broken && failure === "parse_failed") throw new Error("Cannot parse source");
        return extractorRegistry.extract(...args);
      } }
    });
    const options = { database: f.database, projectRoot: ".", indexer };
    const failed = await backfillPurposeSummaries(options);
    assert.equal(failed.succeeded, false);
    assert.equal(failed.results[0].marker, failure);
    assert.equal(failed.results[0].committed, false);
    assert.deepEqual(f.symbols(), before);
    assert.equal(f.database.all("SELECT * FROM purpose_summary_conversion").length, 0);
    broken = false;
    assert.equal((await backfillPurposeSummaries(options)).succeeded, true);
    assert.equal(f.symbols()[0].summary, "Save orders.");
  });
}

test("default rebuild converts unchanged files once without rewriting source", async (t) => {
  const f = await summaryFixture(t, source);
  const root = f.database.databasePath.replace(/\/\.forge\/runtime\/index.db$/, "");
  await writeFile(join(root, f.path), source);
  legacy(f);
  const first = await rebuildIndex({ database: f.database, projectRoot: root });
  assert.equal(first.succeeded, true);
  assert.equal(first.indexedFiles, 1);
  assert.equal(await readFile(join(root, f.path), "utf8"), source);
  const second = await rebuildIndex({ database: f.database, projectRoot: root });
  assert.equal(second.indexedFiles, 0);
  assert.equal(f.symbols()[0].summary, "Save orders.");
});

test("conversion receipts survive closing and reopening the database", async (t) => {
  const f = await summaryFixture(t, source);
  await Promise.resolve();
  legacy(f);
  const root = dirname(dirname(dirname(f.database.databasePath)));
  await writeFile(join(root, f.path), source);
  const before = f.symbols();
  const result = await backfillPurposeSummaries({ database: f.database, indexer: f.indexer });
  assert.equal(result.succeeded, true);
  const jobs = f.database.all("SELECT * FROM embedding_jobs ORDER BY job_id");
  await f.database.close();
  const database = await openIndexDatabase(root);
  t.after(() => database.close());
  const resumed = await backfillPurposeSummaries({ database, projectRoot: root });
  assert.equal(resumed.results[0].status, "unchanged");
  assert.deepEqual(database.all("SELECT * FROM embedding_jobs ORDER BY job_id"), jobs);
  assert.equal(database.all("SELECT symbol_id FROM symbols")[0].symbol_id, before[0].symbol_id);
  assert.equal(await readFile(join(root, f.path), "utf8"), source);
});

test("failed receipt persistence rolls back summaries and permits retry", async (t) => {
  const f = await summaryFixture(t, source);
  legacy(f);
  f.database.run("CREATE TRIGGER reject_conversion BEFORE INSERT ON purpose_summary_conversion BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
  const options = { database: f.database, indexer: f.indexer };
  const failed = await backfillPurposeSummaries(options);
  assert.equal(failed.succeeded, false);
  assert.equal(failed.results[0].marker, "write_failed");
  assert.equal(f.symbols()[0].summary, null);
  assert.equal(f.database.all("SELECT * FROM purpose_summary_conversion").length, 0);
  f.database.run("DROP TRIGGER reject_conversion");
  assert.equal((await backfillPurposeSummaries(options)).succeeded, true);
  assert.equal(f.symbols()[0].summary, "Save orders.");
});

test("missing historical comments are converted once without inventing summaries", async (t) => {
  const f = await summaryFixture(t, "function save() {}");
  legacy(f);
  const options = { database: f.database, projectRoot: ".", indexer: f.indexer };
  assert.equal((await backfillPurposeSummaries(options)).succeeded, true);
  assert.equal(f.symbols()[0].summary, null);
  assert.equal((await backfillPurposeSummaries(options)).results[0].status, "unchanged");
  const file = f.database.all("SELECT * FROM files")[0];
  assert.equal(createSummaryConversion(f.database).needed(file), false);
});
