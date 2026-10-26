// Exercises additive purpose projections against a real SQLite index while
// guarding graph metadata, minimal search results, and structural context objects.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runIndexMigrations } from "../../src/infrastructure/sqlite/index-migrations.js";
import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createCodeIndexSummaryBuilder } from "../../src/modules/index/code-index-summary-builder.js";

test("purpose summaries supplement search projections and preserve structural context", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  runIndexMigrations(sqlite);
  const database = {
    // Mirrors service query rows so projections execute their actual SQL contracts.
    all(sql, params = []) { return sqlite.prepare(sql).all(...params).map((row) => ({ ...row })); },
    // Persists fixture extraction through the production writer's parameterized API.
    run(sql, params = []) { return sqlite.prepare(sql).run(...params); }
  };
  database.run("INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES ('f', 'src/orders.js', 'javascript', 'abc', 100, 'today')");
  const source = "// Orders module.\n\n// Save orders.\nfunction save() {}\nfunction missing() {}";
  const writer = createIndexRecordWriter({ database });
  writer.writeExtraction("f", "src/orders.js", { symbols: [
    { name: "save", kind: "function", start_line: 4, end_line: 4 },
    { name: "missing", kind: "function", start_line: 5, end_line: 5 }
  ], imports: [], exports: [] });
  writer.indexContent("f", "src/orders.js", source);
  const id = database.all("SELECT symbol_id FROM symbols WHERE name = 'save'")[0].symbol_id;
  database.run("INSERT INTO calls (call_id, source_file_id, caller_symbol_id, target_symbol_id, line) VALUES ('c', 'f', ?, ?, 4)", [id, id]);
  const search = createCodeSearch({ database });
  const beforeMinimal = search.search({ query: "orders", kind: "file" });
  const beforeGraph = search.search({ query: "orders", kind: "file", projection: "graph" }).matches[0].node;
  const builder = createCodeIndexSummaryBuilder({ indexDb: database, fileService: { readFile: async () => source } });
  const beforeContext = await builder.build(["src/orders.js"]);
  database.run("UPDATE files SET summary = NULL");
  database.run("UPDATE symbols SET summary = NULL");
  assert.deepEqual(search.search({ query: "orders", kind: "file" }), beforeMinimal);
  assert.equal(search.fileMetadata("src/orders.js").summary, null);
  assert.equal(search.symbolsForFile("src/orders.js")[0].summary, null);
  assert.deepEqual(await builder.build(["src/orders.js"]), beforeContext);
  assert.equal(typeof beforeContext[0].content, "object");
  assert.deepEqual(beforeContext[0].content.functions, ["save", "missing"]);
  writer.clearContentIndex("f");
  writer.indexContent("f", "src/orders.js", source);
  for (const projection of ["summary", "graph"]) {
    const file = search.search({ query: "orders", kind: "file", projection }).matches[0].node;
    assert.equal(file.id, "f");
    assert.equal(file.summary, "Orders module.");
    assert.equal(file.symbols[0].summary, "Save orders.");
    const symbol = search.search({ query: "save", kind: "symbol", projection }).matches[0].node;
    assert.equal(symbol.id, id);
    assert.equal(symbol.summary, "Save orders.");
    assert.equal(symbol.start_line, 4);
    assert.equal(symbol.end_line, 4);
    const content = search.search({ query: "orders", kind: "content", projection });
    assert.ok(content.matches.some((match) => match.node.summary === "Orders module."));
    assert.equal(content.matches.find((match) => match.node.symbol_name === "save").node.summary, "Save orders.");
  }
  const afterGraph = search.search({ query: "orders", kind: "file", projection: "graph" }).matches[0].node;
  assert.deepEqual(afterGraph.graph, beforeGraph.graph);
  assert.equal(afterGraph.graph.calls[0].line, 4);
  assert.equal(search.fileMetadata("src/orders.js").summary, "Orders module.");
  assert.equal(search.symbolsForFile("src/orders.js")[1].summary, null);
  assert.equal("summary" in beforeMinimal.matches[0].node, false);
  assert.deepEqual(await builder.build(["src/orders.js"]), beforeContext);
  assert.equal((await builder.build(["src/orders.js"], { summary: false }))[0].content, source);
});
