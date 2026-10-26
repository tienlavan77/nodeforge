// Exercises scope-sensitive identity and deletion cleanup through real indexing,
// preventing same-name declarations from inheriting another symbol's derived data.
import assert from "node:assert/strict";
import test from "node:test";
import { summaryFixture } from "./purpose-summary-fixture.js";

test("same-name methods retain their own identities when classes reorder", async (t) => {
  const a = "class A {\n// Save A.\nsave() { return 1; }\n}";
  const b = "class B {\n// Save B.\nsave() { return 2; }\n}";
  const f = await summaryFixture(t, "// Module.\n" + a + "\n" + b);
  await f.drain();
  const methods = f.symbols().filter((s) => s.kind === "method");
  const vectors = f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id");
  await f.edit("// Module.\n" + b + "\n" + a.replace("return 1", "return 3"));
  const after = f.symbols().filter((s) => s.kind === "method");
  assert.deepEqual(after.map((s) => s.symbol_id), methods.map((s) => s.symbol_id).reverse());
  assert.deepEqual(after.map((s) => s.summary), ["Save B.", "Save A."]);
  assert.deepEqual(f.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id"), vectors);
  assert.equal(f.inputs.length, 2);
});

test("nested declarations and named object ownership distinguish equal names", async (t) => {
  const a = "function first() {\n// First child.\nfunction child() {}\n}";
  const b = "function second() {\n// Second child.\nfunction child() {}\n}";
  const objects = "const left = {\n// Left method.\nsave() {}\n};\nconst right = {\n// Right method.\nsave() {}\n};";
  const f = await summaryFixture(t, "// Module.\n" + a + "\n" + b + "\n" + objects);
  await f.drain();
  const before = new Map(f.symbols().filter((s) => s.summary).map((s) => [s.summary, s.symbol_id]));
  await f.edit("// Module.\n" + b + "\n" + a + "\n" + objects);
  for (const s of f.symbols().filter((s) => s.summary)) assert.equal(s.symbol_id, before.get(s.summary), s.summary);
});

test("ambiguous anonymous sibling scopes never reuse derived identity", async (t) => {
  const source = "// Module.\n{\n// First.\nfunction save() {}\n}\n{\n// Second.\nfunction save() {}\n}";
  const f = await summaryFixture(t, source);
  await f.drain();
  const ids = f.symbols().map((s) => s.symbol_id);
  await f.edit(source.replace("function save() {}", "function save() { return 1; }"));
  assert.ok(f.symbols().every((s) => !ids.includes(s.symbol_id)));
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 0);
});

test("comment removal, symbol deletion and file deletion clean only invalid records", async (t) => {
  const source = "// Module.\n// Save.\nfunction save() {}\n// Read.\nfunction read() {}";
  const f = await summaryFixture(t, source);
  await f.drain();
  const ids = f.symbols().map((s) => s.symbol_id);
  await f.edit(source.replace("// Save.\n", ""));
  assert.equal(f.symbols()[0].symbol_id, ids[0]);
  assert.equal(f.symbols()[0].summary, null);
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 1);
  assert.equal(f.database.all("SELECT * FROM embedding_jobs WHERE status IN ('pending', 'processing', 'retry_wait')").length, 0);
  assert.deepEqual(f.store.search([1, 0]), [{ path: "orders.js", score: 1 }]);
  await f.edit("// Module.\nfunction save() {}");
  assert.equal(f.database.all("SELECT * FROM symbol_embeddings").length, 0);
  assert.deepEqual(f.store.search([1, 0]), []);
  assert.equal(f.database.all("SELECT * FROM embedding_jobs WHERE symbol_id = ?", [ids[1]]).length, 0);
  await f.edit("", "watcher.file_deleted");
  for (const table of ["symbols", "symbol_embeddings", "embedding_jobs", "file_content_fts", "symbol_content_fts"]) assert.equal(f.database.all("SELECT * FROM " + table).length, 0);
});

test("PHP class methods preserve scoped identity across class reordering", async (t) => {
  const a = "class A {\n// First.\nfunction save() {}\n}";
  const b = "class B {\n// Second.\nfunction save() {}\n}";
  const f = await summaryFixture(t, "<?php\n" + a + "\n" + b, "orders.php");
  await f.drain();
  const ids = f.symbols().filter((s) => s.kind === "method").map((s) => s.symbol_id);
  await f.edit("<?php\n" + b + "\n" + a);
  assert.deepEqual(f.symbols().filter((s) => s.kind === "method").map((s) => s.symbol_id), ids.reverse());
  assert.equal(f.inputs.length, 2);
});
