// Integrates the accepted incremental and worker-race suites with a complete
// create, modify, rename, comment-removal, restart and delete lifecycle. These
// checks exercise real SQLite state and production watcher event handling.
import assert from "node:assert/strict";
import test from "node:test";
import "./purpose-summary-incremental.test.js";
import "./purpose-summary-processing-contract.test.js";
import "./purpose-summary-worker-race.test.js";
import { summaryFixture } from "./purpose-summary-fixture.js";
import { createEmbeddingWorker } from "../../src/modules/index/embedding-worker.js";
import { backfillPurposeSummaries } from "../../src/modules/index/purpose-summary-backfill.js";

test("summary lifecycle preserves durable work through rename and worker restart", async (t) => {
  const source = "// Orders module.\n\n// Save orders.\nfunction save() { return 1; }";
  const f = await summaryFixture(t, source);
  const id = f.symbols()[0].symbol_id;
  assert.equal(f.jobs.counts().pending, 1);
  await f.edit(source.replace("Save orders.", "Validate orders."));
  assert.equal(f.jobs.counts().superseded, 1);
  assert.equal(f.jobs.counts().pending, 1);
  const claimed = f.jobs.claimNext();
  assert.equal(claimed.status, "processing");
  const renamed = await f.indexer.handleDetailed({ type: "watcher.file_renamed", payload: { old_path: f.path, path: "renamed.js" } });
  assert.equal(renamed.committed, true);
  assert.equal(f.symbols()[0].symbol_id, id);
  assert.equal(f.database.all("SELECT path FROM files")[0].path, "renamed.js");
  assert.equal(f.jobs.recoverProcessing(), 1);
  const restarted = createEmbeddingWorker({ database: f.database, jobs: f.jobs, embeddingStore: f.store, embeddingProvider: f.provider, model: "test-model" });
  await restarted.runOnce();
  assert.deepEqual(f.inputs, ["Validate orders."]);
  assert.deepEqual(f.store.search([1, 0]), [{ path: "renamed.js", score: 1 }]);
  assert.equal((await backfillPurposeSummaries({ database: f.database, indexer: f.indexer })).results[0].status, "unchanged");
  // The fixture snapshot uses the same content for every path, as a real rename
  // preserves source bytes until the next watcher modification arrives.
  await f.edit("// Orders module.\nfunction save() { return 1; }");
  // Apply the comment removal to the renamed identity as the watcher would.
  await f.indexer.handleDetailed({ type: "watcher.file_modified", payload: { path: "renamed.js" } });
  assert.equal(f.symbols().find((symbol) => symbol.symbol_id === id).summary, null);
  assert.deepEqual(f.store.search([1, 0]), []);
  const deleted = await f.indexer.handleDetailed({ type: "watcher.file_deleted", payload: { path: "renamed.js" } });
  assert.equal(deleted.status, "deleted");
  assert.equal(f.symbols().some((symbol) => symbol.symbol_id === id), false);
  assert.equal(f.database.all("SELECT * FROM purpose_summary_conversion WHERE file_id NOT IN (SELECT file_id FROM files)").length, 0);
});
