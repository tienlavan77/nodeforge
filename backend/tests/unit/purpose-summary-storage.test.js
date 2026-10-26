// Verifies that purpose documentation survives SQLite upgrades and reindexing without
// changing source search records or inventing descriptions for other symbol kinds.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runIndexMigrations } from "../../src/infrastructure/sqlite/index-migrations.js";
import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";
import { purposeComments, purposeCommentBefore } from "../../src/modules/index/parser/purpose-comments.js";

// Creates an isolated real SQLite index so persistence assertions exercise production SQL.
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  runIndexMigrations(sqlite);
  const database = {
    // Exposes query results with the same plain row shape as the index database service.
    all(sql, params = []) { return sqlite.prepare(sql).all(...params).map((row) => ({ ...row })); },
    // Executes the writer's parameterized updates against the migrated schema.
    run(sql, params = []) { return sqlite.prepare(sql).run(...params); }
  };
  database.run("INSERT INTO files (file_id, path, indexed_at) VALUES ('f', 'orders.js', 'today')");
  const diagnostics = [];
  const writer = createIndexRecordWriter({ database, logger: { warn: (...args) => diagnostics.push(args) } });
  return { sqlite, database, writer, diagnostics };
}

test("legacy rows acquire nullable summaries without losing identity, FTS, or coordinates", (t) => {
  const { sqlite, database } = fixture(t);
  database.run("INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES ('s', 'f', 'save', 'function', 3, 4)");
  database.run("INSERT INTO file_content_fts (file_id, path, content) VALUES ('f', 'orders.js', 'original source')");
  sqlite.exec("ALTER TABLE files DROP COLUMN summary");
  sqlite.exec("ALTER TABLE symbols DROP COLUMN summary");
  sqlite.exec("DELETE FROM schema_migrations WHERE version = 21");
  runIndexMigrations(sqlite);
  runIndexMigrations(sqlite);
  assert.deepEqual(database.all("SELECT file_id, path, summary FROM files"), [{ file_id: "f", path: "orders.js", summary: null }]);
  assert.deepEqual(database.all("SELECT symbol_id, start_line, end_line, summary FROM symbols"), [{ symbol_id: "s", start_line: 3, end_line: 4, summary: null }]);
  assert.equal(database.all("SELECT content FROM file_content_fts")[0].content, "original source");
});

test("stores exactly O1 normalization while preserving existing FTS content", (t) => {
  const { database, writer, diagnostics } = fixture(t);
  const source = "/** Orders.\n * Preserve every warning!\n */\n\n/** Save orders.\n * @returns receipt\n */\nfunction save() {}\n\n// A class comment.\nclass Orders {}\nfunction missing() {}";
  writer.writeExtraction("f", "orders.js", { symbols: [
    { name: "save", kind: "function", start_line: 8, end_line: 8 },
    { name: "Orders", kind: "class", start_line: 11, end_line: 11 },
    { name: "missing", kind: "function", start_line: 12, end_line: 12 }
  ], imports: [], exports: [] });
  writer.indexContent("f", "orders.js", source);
  const document = purposeComments(source);
  const rows = database.all("SELECT name, summary FROM symbols ORDER BY start_line");
  assert.equal(database.all("SELECT summary FROM files")[0].summary, document.header.summary);
  assert.deepEqual(rows, [
    { name: "save", summary: purposeCommentBefore(document, 7).summary },
    { name: "Orders", summary: null }, { name: "missing", summary: null }
  ]);
  assert.equal(database.all("SELECT content FROM file_content_fts")[0].content, source);
  assert.equal(database.all("SELECT content FROM symbol_content_fts WHERE name = 'save'")[0].content, document.comments[1].summary + "\nfunction save() {}");
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics[1][1], { path: "orders.js", object: "symbol", name: "missing", kind: "function", symbol_id: database.all("SELECT symbol_id FROM symbols WHERE name = 'missing'")[0].symbol_id, start_line: 12, end_line: 12, summary: null });
  writer.clearContentIndex("f");
  writer.indexContent("f", "orders.js", source.replace("/** Orders.\n * Preserve every warning!\n */", "\n\n").replace("/** Save orders.\n * @returns receipt\n */", "\n\n"));
  assert.equal(database.all("SELECT summary FROM files")[0].summary, null);
  assert.equal(database.all("SELECT summary FROM symbols WHERE name = 'save'")[0].summary, null);
  assert.ok(diagnostics.some((entry) => entry[1].object === "file" && entry[1].path === "orders.js"));
});

test("files without functions retain header summaries without synthetic symbols", (t) => {
  const { database, writer } = fixture(t);
  for (const [path, source] of [
    ["orders.js", "// Orders configuration.\nconst enabled = true;"],
    ["orders.css", "/* Orders presentation. */\n.orders { color: red; }"],
    ["orders.php", "<?php\n/* Orders configuration. */\n$value = 1;"]
  ]) {
    writer.clearContentIndex("f");
    writer.indexContent("f", path, source);
    assert.match(database.all("SELECT summary FROM files")[0].summary, /^Orders/);
    assert.equal(database.all("SELECT * FROM symbols").length, 0);
  }
});
