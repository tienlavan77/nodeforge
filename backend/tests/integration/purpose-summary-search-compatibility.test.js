// Exercises additive purpose projections against a real SQLite index while
// guarding graph metadata, minimal search results, and structural context objects.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
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
  const root = await mkdtemp(join(tmpdir(), "forge-purpose-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src/private"), { recursive: true });
  await writeFile(join(root, "src/orders.js"), source);
  await writeFile(join(root, "src/private/orders.js"), source);
  const files = createFileService({ projectRoot: root });
  const scopedFiles = createRoleFileService({ fileService: files, role: "coder", projectRoot: root });
  const read = createReadFileTool({ fileService: scopedFiles, projectRoot: root });
  assert.equal(await scopedFiles.readFile({ path: "src/orders.js" }), source);
  assert.equal((await read.execute({ path: "src/orders.js", offset: 1, limit: 5 })).content, source);
  const builder = createCodeIndexSummaryBuilder({ indexDb: database, fileService: scopedFiles });
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

  // Populate both summaries for a real file denied by the existing private-path
  // policy, ensuring persisted index data cannot bypass the read boundary.
  const deniedPath = "src/private/orders.js";
  database.run("INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES ('denied', ?, 'javascript', 'def', 100, 'today')", [deniedPath]);
  writer.writeExtraction("denied", deniedPath, { symbols: [
    { name: "save", kind: "function", start_line: 4, end_line: 4 }
  ], imports: [], exports: [] });
  writer.indexContent("denied", deniedPath, source);
  assert.equal(search.fileMetadata(deniedPath).summary, "Orders module.");
  assert.equal(search.symbolsForFile(deniedPath)[0].summary, "Save orders.");
  await assert.rejects(() => scopedFiles.readFile({ path: deniedPath }), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(() => read.execute({ path: deniedPath }), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(() => read.execute({ path: deniedPath, offset: 1, limit: 5 }), { code: "FILE_ROLE_FORBIDDEN" });
  for (const summary of [true, false]) {
    const denied = await builder.build([deniedPath], { summary });
    assert.deepEqual(denied, [{
      path: deniedPath, exists: false, before_checksum: null,
      language: "javascript", size_bytes: 0, content: null
    }]);
  }
});
