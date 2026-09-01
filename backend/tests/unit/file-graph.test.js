import assert from "node:assert/strict";
import test from "node:test";
import { createFileGraph } from "../../src/modules/index/file-graph.js";

function database() {
  const files = [
    { file_id: "a", path: "src/a.js", language: "javascript", sha256: "sha256:a", size_bytes: 1 },
    { file_id: "b", path: "src/b.js", language: "javascript", sha256: "sha256:b", size_bytes: 1 },
    { file_id: "c", path: "src/c.js", language: "javascript", sha256: "sha256:c", size_bytes: 1 }
  ];
  const edges = [{ source_file_id: "a", target_file_id: "b", kind: "import", is_broken: 0 }, { source_file_id: "b", target_file_id: "c", kind: "require", is_broken: 0 }];
  return { all(sql, params = []) {
    if (sql.includes("FROM files WHERE path")) return files.filter((file) => file.path === params[0]);
    if (sql.includes("FROM imports_exports") && sql.includes("WHERE rel.file_id")) return [];
    if (sql.includes("FROM imports_exports") && sql.includes("WHERE rel.related_file_id")) return [];
    if (sql.includes("FROM dependency_edges") && sql.includes("WHERE edge.source_file_id")) return edges.filter((edge) => edge.source_file_id === params[0]).map((edge) => ({ ...files.find((file) => file.file_id === edge.target_file_id), target_id: edge.target_file_id, target_path: files.find((file) => file.file_id === edge.target_file_id).path, kind: edge.kind, is_broken: edge.is_broken }));
    if (sql.includes("FROM dependency_edges") && sql.includes("WHERE edge.target_file_id")) return edges.filter((edge) => edge.target_file_id === params[0]).map((edge) => ({ ...files.find((file) => file.file_id === edge.source_file_id), source_id: edge.source_file_id, source_path: files.find((file) => file.file_id === edge.source_file_id).path, kind: edge.kind, is_broken: edge.is_broken }));
    if (sql.includes("index_metadata")) return [{ version: 4 }];
    return [];
  } };
}

test("queries dependencies and reverse dependents with bounded depth", () => {
  const graph = createFileGraph({ database: database() });
  const dependencies = graph.getDependencies("src/a.js", 2);
  assert.deepEqual(dependencies.nodes.map((node) => node.path), ["src/a.js", "src/b.js", "src/c.js"]);
  assert.deepEqual(dependencies.edges.map((edge) => edge.kind), ["dependency", "require"]);
  assert.equal(graph.getDependents("src/c.js", 1).nodes[1].path, "src/b.js");
});

test("rejects missing files and unsafe depth", () => {
  const graph = createFileGraph({ database: database() });
  assert.throws(() => graph.getImports("missing.js"), /Indexed file not found/);
  assert.throws(() => graph.getDependencies("src/a.js", 11), /between 0 and 10/);
});
