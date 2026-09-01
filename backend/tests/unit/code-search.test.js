import assert from "node:assert/strict";
import test from "node:test";
import { createCodeSearch } from "../../src/modules/index/code-search.js";

function database() {
  const files = [{ file_id: "a", path: "src/events/publisher.js", language: "javascript", sha256: "sha256:a", size_bytes: 10 }, { file_id: "b", path: "src/workflows/runner.js", language: "javascript", sha256: "sha256:b", size_bytes: 20 }];
  const symbols = [{ symbol_id: "sa", file_id: "a", name: "publish", kind: "function", start_line: 2, end_line: 6 }, { symbol_id: "sb", file_id: "b", name: "runTicket", kind: "function", start_line: 3, end_line: 12 }];
  return { all(sql) { if (sql.startsWith("SELECT file_id")) return files; if (sql.startsWith("SELECT s.symbol_id")) return symbols.map((row) => ({ ...row, ...files.find((file) => file.file_id === row.file_id) })); if (sql.includes("file_content_fts")) return [{ file_id: "a", path: "src/events/publisher.js", language: "javascript", rank: 0 }]; if (sql.includes("index_metadata")) return [{ version: 9 }]; return []; } };
}

test("searches indexed paths and symbols with score/reason", () => {
  const search = createCodeSearch({ database: database() });
  const result = search.search({ query: "publish", kind: "all" });
  assert.equal(result.matches[0].type, "symbol");
  assert.equal(result.matches[0].node.name, "publish");
  assert.match(result.matches[0].reason[0], /symbol_exact/);
  assert.equal(result.index_version, "IDX-9");
});

test("validates search kind, query, and limit", () => {
  const search = createCodeSearch({ database: database() });
  assert.throws(() => search.search({ query: " " }), /query is required/);
  assert.throws(() => search.search({ query: "x", kind: "invalid" }), /Unsupported Code Search kind/);
  assert.throws(() => search.search({ query: "x", limit: 101 }), /between 1 and 100/);
});

test("searches indexed content through FTS", () => {
  const result = createCodeSearch({ database: database() }).search({ query: "publish notification", kind: "content" });
  assert.equal(result.matches[0].type, "content");
  assert.equal(result.matches[0].node.path, "src/events/publisher.js");
});

test("tokenizes Vietnamese queries without creating ASCII fragments", () => {
  const queries = [];
  const source = database();
  const search = createCodeSearch({ database: { ...source, all(sql, parameters) { if (sql.includes("file_content_fts")) queries.push(parameters[0]); return source.all(sql, parameters); } } });
  search.search({ query: "Hiển thị trạng thái và UI", kind: "content" });
  assert.equal(queries[0], '"hiển" AND "thị" AND "trạng" AND "thái" AND "ui"');
});

test("removes shared stop words but preserves technical terms", () => {
  const queries = [];
  const source = database();
  const search = createCodeSearch({ database: { ...source, all(sql, parameters) { if (sql.includes("file_content_fts")) queries.push(parameters[0]); return source.all(sql, parameters); } } });
  search.search({ query: "the UI and API for ticket trong một sprint", kind: "content" });
  assert.equal(queries[0], '"ui" AND "api" AND "ticket" AND "sprint"');
});
