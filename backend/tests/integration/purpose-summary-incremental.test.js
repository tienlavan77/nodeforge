// Verifies that source edits refresh code, graph and coordinates while only
// changed purpose summaries invalidate and reschedule derived work.
import assert from "node:assert/strict";
import test from "node:test";
import { summaryFixture } from "./purpose-summary-fixture.js";

const initial = "// Order module.\n\n// Save orders.\nfunction save() { return 1; }\n// Read orders.\nfunction read() { return save(); }";

test("implementation and comment formatting preserve identity, vectors and completed jobs", async (t) => {
  const f = await summaryFixture(t, initial);
  await f.drain();
  const symbols = f.symbols();
  const vectors = f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id");
  const jobs = f.database.all("SELECT * FROM embedding_jobs ORDER BY job_id");
  await f.edit(initial.replace("// Save orders.", "/* Save orders. */").replace("return 1", "return 200"));
  assert.deepEqual(f.symbols(), symbols);
  assert.deepEqual(f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id"), vectors);
  assert.deepEqual(f.database.all("SELECT * FROM embedding_jobs ORDER BY job_id"), jobs);
  assert.match(f.database.all("SELECT content FROM file_content_fts")[0].content, /return 200/);
  assert.match(f.database.all("SELECT content FROM symbol_content_fts WHERE name = 'save'")[0].content, /return 200/);
  await f.edit("\n\n" + initial.replace("return save()", "return 2"));
  assert.deepEqual(f.symbols().map((s) => s.symbol_id), symbols.map((s) => s.symbol_id));
  assert.equal(f.symbols()[0].start_line, symbols[0].start_line + 2);
  assert.equal(f.database.all("SELECT * FROM calls").length, 0);
  assert.deepEqual(f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id"), vectors);
  await f.drain();
  assert.equal(f.inputs.length, 2);
});

test("purpose edits process only the affected symbol and preserve its sibling", async (t) => {
  const f = await summaryFixture(t, initial);
  await f.drain();
  const before = f.symbols();
  const sibling = f.database.all("SELECT * FROM symbol_embeddings WHERE symbol_id = ?", [before[1].symbol_id]);
  await f.edit(initial.replace("Save orders.", "Validate and save orders."));
  assert.deepEqual(f.symbols().map((s) => s.symbol_id), before.map((s) => s.symbol_id));
  assert.equal(f.symbols()[0].summary, "Validate and save orders.");
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 1);
  assert.deepEqual(f.database.all("SELECT * FROM symbol_embeddings WHERE symbol_id = ?", [before[1].symbol_id]), sibling);
  assert.equal(f.jobs.counts().pending, 1);
  await f.drain();
  assert.deepEqual(f.inputs, ["Save orders.", "Read orders.", "Validate and save orders."]);
});

test("a failed indexing transaction retains source, identities, vectors and jobs", async (t) => {
  const f = await summaryFixture(t, initial);
  await f.drain();
  const symbols = f.symbols();
  const vectors = f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id");
  const jobs = f.database.all("SELECT * FROM embedding_jobs ORDER BY job_id");
  f.database.run("CREATE TRIGGER reject_summary BEFORE UPDATE OF summary ON symbols WHEN NEW.summary = 'Changed purpose.' BEGIN SELECT RAISE(ABORT, 'rejected'); END");
  await assert.rejects(f.edit(initial.replace("Save orders.", "Changed purpose.")), /rejected/);
  assert.deepEqual(f.symbols(), symbols);
  assert.deepEqual(f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id"), vectors);
  assert.deepEqual(f.database.all("SELECT * FROM embedding_jobs ORDER BY job_id"), jobs);
});
