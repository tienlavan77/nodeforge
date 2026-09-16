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
  assert.equal(result.discovery_budget.used, 0);
  assert.equal(result.discovery_budget.remaining, 8);
  assert.deepEqual(result.matches.map((match) => match.path), ["frontend/src/Header.jsx", "frontend/README.md"]);
  assert.equal(result.matches[0].size_bytes, 120);
  assert.equal("content" in result.matches[0], false);
  assert.deepEqual(makeTool.lastInput, { query: "Header", kind: "file", limit: 2 });
});

test("returns symbol metadata only", async () => {
  const result = await makeTool({ index_version: "IDX-1", matches: [{ type: "symbol", score: 1, reason: ["symbol_exact:header"], node: { path: "frontend/src/Header.jsx", name: "Header", symbol_kind: "component", start_line: 3, end_line: 10 } }] }).execute({ query: "Header", kind: "symbol", limit: 5, allowed_prefixes: ["frontend/"] }, context);
  assert.deepEqual(result.matches[0], { kind: "symbol", path: "frontend/src/Header.jsx", name: "Header", symbol_kind: "component", start_line: 3, end_line: 10, score: 1, reason: ["symbol_exact:header"] });
});

test("returns content matches with FTS snippet", async () => {
  const result = await makeTool({ index_version: "IDX-2", matches: [{ type: "content", score: 0.9, reason: ["content_match:header"], node: { path: "frontend/src/Header.jsx", language: "javascript", sha256: "abc", size_bytes: 120, snippet: "»Header« renders title" } }] }).execute({ query: "Header", kind: "content", limit: 5, allowed_prefixes: ["frontend/"] }, context);
  assert.equal(result.matches[0].kind, "content");
  assert.equal(result.matches[0].path, "frontend/src/Header.jsx");
  assert.equal(result.matches[0].snippet, "»Header« renders title");
  assert.equal(result.matches[0].sha256, "abc");
});

test("attaches a hint when no matches survive scoping", async () => {
  const hintContext = { task_id: "TASK-HINT", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] };
  const result = await makeTool({ index_version: "IDX-3", matches: [{ type: "content", score: 1, reason: ["content_match:x"], node: { path: "backend/secret.js", language: "javascript", snippet: "x" } }] }).execute({ query: "Header", kind: "content", limit: 5, allowed_prefixes: ["frontend/"] }, hintContext);
  assert.deepEqual(result.matches, []);
  assert.match(result.hint, /AND-joined/);
  assert.match(result.hint, /projection:"summary"/);
  const nonEmpty = await makeTool().execute(input, hintContext);
  assert.equal(nonEmpty.hint, undefined);
});

test("refuses exploration after three consecutive unproductive searches and resets after an edit", async () => {
  const empty = { index_version: "IDX-4", matches: [] };
  const tool = makeTool(empty);
  const context = { task_id: "TASK-STAG", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] };
  const input = { query: "guess", kind: "content", limit: 5, allowed_prefixes: ["frontend/"] };
  await tool.execute(input, context);
  await tool.execute({ ...input, query: "guess2" }, context);
  await assert.rejects(() => tool.execute({ ...input, query: "guess3" }, context), (error) => error.code === "EXPLORATION_STAGNANT");

  const productive = makeTool(searchResult);
  await productive.execute({ query: "Header", kind: "file", limit: 2, allowed_prefixes: ["frontend/"] }, context);
  await productive.execute({ query: "Header", kind: "file", limit: 2, allowed_prefixes: ["frontend/"] }, context);
  await productive.execute({ query: "Header", kind: "file", limit: 2, allowed_prefixes: ["frontend/"] }, context);

  const dynamic = createSearchCodeTool({ codeSearch: { search: async (searchInput) => ({ index_version: "IDX-5", matches: [{ type: "file", score: 1, reason: ["path_match:widget"], node: { path: `frontend/src/${searchInput.query}.jsx`, language: "javascript" } }] }) } });
  const longTask = { task_id: "TASK-LONG", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] };
  for (let i = 0; i < 8; i += 1) await dynamic.execute({ query: `widget-${i}`, kind: "file", limit: 2, allowed_prefixes: ["frontend/"] }, longTask);
});

test("rejects invalid scope, input, and authorization", async () => {
  const tool = makeTool();
  await assert.rejects(() => tool.execute(input, { ...context, capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
  await assert.rejects(() => tool.execute(input, { ...context, task_id: "" }), (error) => error.code === "TOOL_SCOPE_INVALID");
  await assert.rejects(() => tool.execute({ ...input, kind: "graph" }, context), (error) => error.code === "SEARCH_KIND_INVALID");
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
