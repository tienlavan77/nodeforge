import assert from "node:assert/strict";
import test from "node:test";
import { createFunctionGraph } from "../../src/modules/index/function-graph.js";

function database() {
  const files = [{ file_id: "a", path: "src/a.js", language: "javascript", sha256: "sha256:a", size_bytes: 10 }, { file_id: "b", path: "src/b.js", language: "javascript", sha256: "sha256:b", size_bytes: 20 }];
  const symbols = [{ symbol_id: "sa", file_id: "a", name: "publish", kind: "function", start_line: 2, end_line: 6 }, { symbol_id: "sb", file_id: "b", name: "run", kind: "function", start_line: 3, end_line: 12 }];
  const calls = [{ call_id: "c1", source_file_id: "b", caller_symbol_id: "sb", target_symbol_id: "sa", line: 8 }];
  return { all(sql, params = []) {
    if (sql.includes("FROM files WHERE path")) return files.filter((row) => row.path === params[0]);
    if (sql.includes("FROM symbols WHERE file_id = ? AND name")) return symbols.filter((row) => row.file_id === params[0] && row.name === params[1]);
    if (sql.includes("FROM symbols WHERE file_id = ? ORDER")) return symbols.filter((row) => row.file_id === params[0]);
    if (sql.includes("FROM calls") && sql.includes("WHERE calls.caller_symbol_id")) return calls.filter((row) => row.caller_symbol_id === params[0]).map((row) => ({ ...row, target_id: "sa", target_name: "publish", target_kind: "function", target_start_line: 2, target_end_line: 6, target_file_id: "a", target_path: "src/a.js", target_language: "javascript", target_sha256: "sha256:a" }));
    if (sql.includes("FROM calls") && sql.includes("WHERE calls.target_symbol_id")) return calls.filter((row) => row.target_symbol_id === params[0]).map((row) => ({ ...row, source_path: "src/b.js", source_language: "javascript", source_sha256: "sha256:b", source_file_id: "b", caller_id: "sb", caller_name: "run", caller_kind: "function", caller_start_line: 3, caller_end_line: 12 }));
    if (sql.includes("index_metadata")) return [{ version: 7 }];
    return [];
  } };
}

test("returns function definitions and caller/callee locations", () => {
  const graph = createFunctionGraph({ database: database() });
  assert.equal(graph.getFunctions("src/a.js").nodes[0].start_line, 2);
  const callers = graph.getCallers("src/a.js", "publish");
  assert.deepEqual(callers.called_by, [{ file: "src/b.js", function: "run", line: 8, kind: "static_call" }]);
  const callees = graph.getCallees("src/b.js", "run");
  assert.deepEqual(callees.calls, [{ file: "src/a.js", function: "publish", line: 8, kind: "static_call" }]);
});

test("rejects missing function", () => {
  const graph = createFunctionGraph({ database: database() });
  assert.throws(() => graph.getCallers("src/a.js", "missing"), /Indexed function not found/);
});
