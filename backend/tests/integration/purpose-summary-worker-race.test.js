// Verifies delayed provider responses cannot publish obsolete vectors or revive
// superseded work after summary edits, removal or symbol deletion.
import assert from "node:assert/strict";
import test from "node:test";
import { summaryFixture } from "./purpose-summary-fixture.js";
import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";

const source = "// Module.\n\n// Save orders.\nfunction save() {}";

for (const [label, changed] of [
  ["summary change", source.replace("Save orders.", "Validate orders.")],
  ["comment removal", source.replace("// Save orders.\n", "")],
  ["symbol deletion", "// Module."],
  ["file deletion", null]
]) {
  test("worker rejects delayed success after " + label, async (t) => {
    const f = await summaryFixture(t, source);
    let finish;
    f.provider.embed = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.worker.runOnce();
    assert.equal(typeof finish, "function");
    await f.edit(changed ?? "", changed === null ? "watcher.file_deleted" : "watcher.file_modified");
    finish([1, 0]);
    await pending;
    assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 0);
    assert.deepEqual(f.store.search([1, 0]), []);
    assert.equal(f.database.all("SELECT * FROM embedding_jobs WHERE status = 'completed'").length, 0);
    if (label === "summary change") {
      f.provider.embed = async () => [0, 1];
      await f.drain();
      assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 1);
      assert.equal(f.jobs.counts().completed, 1);
    }
  });
}

test("a delayed provider failure cannot revive a superseded job", async (t) => {
  const f = await summaryFixture(t, source);
  let fail;
  f.provider.embed = () => new Promise((resolve, reject) => { fail = reject; });
  const pending = f.worker.runOnce();
  await f.edit(source.replace("Save orders.", "Validate orders."));
  fail(new Error("delayed failure"));
  await pending;
  assert.equal(f.jobs.counts().superseded, 1);
  assert.equal(f.jobs.counts().pending, 1);
  assert.equal(f.jobs.counts().retry_wait, undefined);
});

test("implementation changes during processing preserve the valid in-flight result", async (t) => {
  const f = await summaryFixture(t, source);
  let finish;
  f.provider.embed = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.worker.runOnce();
  const id = f.symbols()[0].symbol_id;
  await f.edit(source.replace("{}", "{ return 200; }"));
  assert.equal(f.symbols()[0].symbol_id, id);
  assert.equal(f.jobs.counts().processing, 1);
  finish([1, 0]);
  await pending;
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 1);
  assert.equal(f.jobs.counts().completed, 1);
});

test("direct-provider processing rejects an obsolete summary after awaiting", async (t) => {
  const f = await summaryFixture(t, source);
  let finish;
  const writer = createIndexRecordWriter({ database: f.database, embeddingStore: f.store,
    embeddingProvider: { embed: () => new Promise((resolve) => { finish = resolve; }) },
    embeddingModel: "test-model", logger: console });
  const fileId = f.symbols()[0].file_id;
  writer.clearContentIndex(fileId, true);
  writer.indexContent(fileId, f.path, source);
  await f.edit(source.replace("Save orders.", "Validate orders."));
  finish([1, 0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 0);
});

test("failed publication rolls back the vector and job completion together", async (t) => {
  const f = await summaryFixture(t, source);
  f.database.run("CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON embedding_jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'completion failed'); END");
  await f.worker.runOnce();
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 0);
  assert.equal(f.jobs.counts().retry_wait, 1);
});
