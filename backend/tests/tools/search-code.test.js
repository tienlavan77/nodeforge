import assert from "node:assert/strict";
import test from "node:test";
import { createSearchCodeTool } from "../../src/tools/search-code.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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

test("prewarms approved search results and hides indexed ranges when source changed", async () => {
  const paths = [];
  const codeCache = { prewarm: async (items) => {
    paths.push(...items);
    return new Map([["frontend/src/Header.jsx", { indexed_sha256: "sha256:old", content_sha256: "sha256:new", index_status: "stale" }]]);
  } };
  const result = await createSearchCodeTool({ codeSearch: { search: async () => ({ index_version: "IDX-2", matches: [{ score: 1, node: { path: "frontend/src/Header.jsx", snippet: "old source", symbol_name: "Header", start_line: 2, end_line: 5 } }] }) }, codeCache })
    .execute({ query: "Header", kind: "content", limit: 5, allowed_prefixes: ["frontend/"] }, { task_id: "TASK-CACHE-SEARCH", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] });
  assert.deepEqual(paths, ["frontend/src/Header.jsx"]);
  assert.equal(result.matches[0].index_status, "stale");
  assert.equal(result.matches[0].snippet, undefined);
  assert.equal(result.matches[0].start_line, undefined);
});

test("search_code returns results when cache prewarm fails and logs the failure", async () => {
  const logs = [];
  const result = await createSearchCodeTool({ codeSearch: { search: async () => searchResult }, codeCache: { prewarm: async () => { throw new Error("cache stopped"); } }, projectLogger: (entry) => logs.push(entry) }).execute(input, { task_id: "TASK-PREWARM-ERROR", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] });
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].index_status, "unavailable");
  assert.equal(logs[0].event_name, "search_code.prewarm_failed");
  assert.equal(JSON.stringify(logs).includes("Header"), false);
});

test("search_code freshness results validate against the strict result schema", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/agent/tools/search-code-result.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
  const source = { index_version: "IDX-3", matches: [
    { score: 1, node: { path: "frontend/src/Header.jsx", name: "Header", symbol_kind: "function", start_line: 1, end_line: 3 } }
  ] };
  const codeCache = { prewarm: async () => new Map([["frontend/src/Header.jsx", { indexed_sha256: `sha256:${"a".repeat(64)}`, content_sha256: `sha256:${"b".repeat(64)}`, index_status: "stale" }]]) };
  const result = await createSearchCodeTool({ codeSearch: { search: async () => source }, codeCache }).execute({ query: "Header", kind: "symbol", limit: 5, allowed_prefixes: ["frontend/"] }, { task_id: "TASK-STRICT-SCHEMA", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] });
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  const fileResult = await createSearchCodeTool({ codeSearch: { search: async () => searchResult }, codeCache: { prewarm: async () => new Map() } }).execute(input, { task_id: "TASK-STRICT-FILE", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] });
  assert.equal(validate(fileResult), true, JSON.stringify(validate.errors));
  const contentResult = await createSearchCodeTool({ codeSearch: { search: async () => ({ index_version: "IDX-3", matches: [{ score: 1, node: { path: "frontend/src/Header.jsx", language: "javascript", snippet: "old", symbol_name: "Header", start_line: 1, end_line: 3 } }] }) }, codeCache }).execute({ query: "Header", kind: "content", limit: 5, allowed_prefixes: ["frontend/"] }, { task_id: "TASK-STRICT-CONTENT", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] });
  assert.equal(validate(contentResult), true, JSON.stringify(validate.errors));
});

test("shows only readable graph relations inside the approved search scope", async () => {
  const graph = {
    imports: [{ path: "frontend/src/helper.js", name: "helper", kind: "import", broken: false }, { path: "backend/private.js", name: "secret", kind: "import", broken: false }],
    imported_by: [{ path: "frontend/src/App.jsx", name: "Header", kind: "import", broken: false }, { path: ".forge/runtime/hidden.js", name: "hidden", kind: "import", broken: false }],
    calls: [{ caller: { path: "frontend/src/Header.jsx", name: "render" }, target: { path: "frontend/src/helper.js", name: "format" }, line: 4 }, { caller: { path: "frontend/src/Header.jsx", name: "render" }, target: { path: "backend/private.js", name: "secret" }, line: 5 }],
    index_version: "IDX-9"
  };
  const result = await makeTool({ index_version: "IDX-9", matches: [{ type: "file", score: 1, node: { path: "frontend/src/Header.jsx", graph } }] })
    .execute({ ...input, projection: "graph" }, { task_id: "TASK-GRAPH-SCOPE", capabilities: ["search_code"], allowed_prefixes: ["frontend/"] });
  assert.deepEqual(result.matches[0].graph, {
    imports: [graph.imports[0]], imported_by: [graph.imported_by[0]], calls: [graph.calls[0]], index_version: "IDX-9"
  });
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
