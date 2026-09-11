import assert from "node:assert/strict";
import test from "node:test";
import { createSearchCodeTool } from "../../src/tools/search-code.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";

const searchResult = {
  index_version: "IDX-9",
  matches: [
    { type: "file", score: 0.9, reason: ["path_match:header"], node: { path: "frontend/src/Header.jsx", language: "javascript", sha256: "abc", size_bytes: 120 } },
    { type: "file", score: 0.8, reason: ["path_match:header"], node: { path: "backend/src/Header.js", language: "javascript", sha256: "def", size_bytes: 80 } },
    { type: "file", score: 0.7, reason: ["path_match:header"], node: { path: "frontend/README.md", language: "markdown", sha256: "ghi", size_bytes: 20, content: "must not leak" } }
  ]
};

function makeTool(result = searchResult) {
  const codeSearch = { search: async (input) => { makeTool.lastInput = input; return result; } };
  return createSearchCodeTool({ codeSearch });
}
const context = { task_id: "TASK-1", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] };
const input = { query: " Header ", kind: "file", limit: 2, allowed_prefixes: ["frontend/"] };

test("searches files, scopes paths, preserves ranking metadata, and omits content", async () => {
  const result = await makeTool().execute(input, context);
  assert.equal(result.task_id, "TASK-1");
  assert.equal(result.query, "Header");
  assert.equal(result.index_version, "IDX-9");
  assert.deepEqual(result.matches.map((match) => match.path), ["frontend/src/Header.jsx", "frontend/README.md"]);
  assert.equal(result.matches[0].size_bytes, 120);
  assert.equal("content" in result.matches[0], false);
  assert.deepEqual(makeTool.lastInput, { query: "Header", kind: "file", limit: 2 });
});

test("returns symbol metadata only", async () => {
  const result = await makeTool({ index_version: "IDX-1", matches: [{ type: "symbol", score: 1, reason: ["symbol_exact:header"], node: { path: "frontend/src/Header.jsx", name: "Header", symbol_kind: "component", start_line: 3, end_line: 10 } }] }).execute({ query: "Header", kind: "symbol", limit: 5, allowed_prefixes: ["frontend/"] }, context);
  assert.deepEqual(result.matches[0], { kind: "symbol", path: "frontend/src/Header.jsx", name: "Header", symbol_kind: "component", start_line: 3, end_line: 10, score: 1, reason: ["symbol_exact:header"] });
});

test("rejects invalid scope, input, and authorization", async () => {
  const tool = makeTool();
  await assert.rejects(() => tool.execute(input, { ...context, capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
  await assert.rejects(() => tool.execute(input, { ...context, task_id: "" }), (error) => error.code === "TOOL_SCOPE_INVALID");
  await assert.rejects(() => tool.execute({ ...input, kind: "content" }, context), (error) => error.code === "SEARCH_KIND_INVALID");
  await assert.rejects(() => tool.execute({ ...input, query: " " }, context), (error) => error.code === "SEARCH_QUERY_INVALID");
  await assert.rejects(() => tool.execute({ ...input, limit: 51 }, context), (error) => error.code === "SEARCH_LIMIT_INVALID");
  await assert.rejects(() => tool.execute({ ...input, allowed_prefixes: ["backend/"] }, context), (error) => error.code === "SEARCH_SCOPE_FORBIDDEN");
  await assert.rejects(() => tool.execute({ ...input, allowed_prefixes: ["../"] }, context), (error) => error.code === "SEARCH_SCOPE_FORBIDDEN");
});

test("registry exposes search_code only when Forge Code Search is injected", async () => {
  const base = { protocolStorage: { get: async () => ({}) }, fileService: { readForIndex: async () => ({}) } };
  assert.equal(createForgeToolRegistry(base).search_code, undefined);
  const registry = createForgeToolRegistry({ ...base, codeSearch: { search: async () => searchResult } });
  assert.equal(registry.search_code.name, "search_code");
  await assert.rejects(() => registry.search_code.execute(input, { ...context, capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
});

test("maps Code Search backend failures", async () => {
  const tool = makeTool();
  const failing = createSearchCodeTool({ codeSearch: { search: async () => { throw new Error("db down"); } } });
  await assert.rejects(() => failing.execute(input, context), (error) => error.code === "SEARCH_BACKEND_ERROR");
  assert.ok(tool);
});
