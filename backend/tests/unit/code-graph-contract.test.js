import assert from "node:assert/strict";
import test from "node:test";
import {
  createFileNode,
  createFileUsageResult,
  createFunctionUsageResult,
  createGraphEdge,
  createGraphQueryResult,
  createSymbolNode
} from "../../src/modules/index/code-graph-contract.js";

test("creates stable file and symbol nodes", () => {
  const file = createFileNode({ path: "src/a.js", language: "javascript", sha256: "sha256:abc", sizeBytes: 12, indexVersion: "IDX-1" });
  const symbol = createSymbolNode({ path: file.path, name: "run", symbolKind: "function", startLine: 2, endLine: 4 });
  assert.deepEqual(file, { kind: "file", id: null, path: "src/a.js", language: "javascript", sha256: "sha256:abc", size_bytes: 12, index_version: "IDX-1" });
  assert.equal(symbol.start_line, 2);
});

test("creates file and function usage contracts", () => {
  const file = createFileNode({ path: "src/a.js" });
  const symbol = createSymbolNode({ path: file.path, name: "run", symbolKind: "function" });
  const edge = createGraphEdge({ from: "src/b.js", to: "src/a.js", kind: "import", confidence: "static" });
  const query = createGraphQueryResult({ nodes: [file], edges: [edge], indexVersion: "IDX-2" });
  const fileUsage = createFileUsageResult({ file, importedBy: [edge], indexVersion: "IDX-2" });
  const functionUsage = createFunctionUsageResult({ symbol, calledBy: [{ file: "src/b.js", line: 9 }] });
  assert.equal(query.edges[0].kind, "import");
  assert.equal(fileUsage.file_links.imported_by[0].from, "src/b.js");
  assert.equal(functionUsage.function.name, "run");
});

test("rejects invalid graph contracts", () => {
  assert.throws(() => createFileNode(), /requires a path/);
  assert.throws(() => createGraphEdge({ from: "a", to: "b", kind: "unknown" }), /Unsupported Code Graph edge kind/);
  assert.throws(() => createGraphQueryResult({ nodes: null }), /must be arrays/);
});
