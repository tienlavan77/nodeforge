import assert from "node:assert/strict";
import test from "node:test";
import { createReadCodeTool } from "../../src/tools/read-code.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";

const source = "one\ntwo\nthree\nfour";
const context = {
  task_id: "TASK-READ-1",
  capabilities: ["read_code"],
  allowed_file_paths: ["src/example.js"],
  allowed_symbols: [{ path: "src/example.js", name: "Example", symbol_kind: "function", start_line: 2, end_line: 3 }]
};
function fileService(result = { path: "src/example.js", content: source, language: "javascript", sha256: "sha256:test", size_bytes: source.length }) {
  return { readForIndex: async ({ path }) => { fileService.lastPath = path; return result; } };
}
function tool(service = fileService()) { return createReadCodeTool({ fileService: service }); }
const fileInput = { kind: "file", path: "src/example.js", symbol: null, start_line: null, end_line: null, max_chars: 50000 };

test("reads one exact approved file through Forge File Service", async () => {
  const result = await tool().execute(fileInput, context);
  assert.equal(result.content, source);
  assert.equal(result.path, "src/example.js");
  assert.equal(result.truncated, false);
  assert.equal(fileService.lastPath, "src/example.js");
  assert.equal("symbol" in result, false);
});

test("reads only the exact approved symbol range", async () => {
  const result = await tool().execute({ kind: "symbol", path: "src/example.js", symbol: "Example", start_line: 2, end_line: 3, max_chars: 50000 }, context);
  assert.equal(result.content, "two\nthree");
  assert.equal(result.symbol_kind, "function");
  assert.equal(result.start_line, 2);
  assert.equal(result.end_line, 3);
});

test("rejects resources outside Node exact allowlists", async () => {
  const read = tool();
  await assert.rejects(() => read.execute({ ...fileInput, path: "src/other.js" }, context), (error) => error.code === "READ_PATH_FORBIDDEN");
  await assert.rejects(() => read.execute({ ...fileInput, path: "../secret" }, { ...context, allowed_file_paths: ["../secret"] }), (error) => error.code === "READ_PATH_FORBIDDEN");
  await assert.rejects(() => read.execute({ ...fileInput, path: "/etc/passwd" }, context), (error) => error.code === "READ_PATH_FORBIDDEN");
  await assert.rejects(() => read.execute({ kind: "symbol", path: "src/example.js", symbol: "Other", start_line: 2, end_line: 3, max_chars: 50000 }, context), (error) => error.code === "READ_SYMBOL_FORBIDDEN");
  await assert.rejects(() => read.execute({ kind: "symbol", path: "src/example.js", symbol: "Example", start_line: 1, end_line: 3, max_chars: 50000 }, context), (error) => error.code === "READ_SYMBOL_FORBIDDEN");
});

test("enforces authorization, limits, ignored paths, and backend errors", async () => {
  const read = tool();
  await assert.rejects(() => read.execute(fileInput, { ...context, capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
  await assert.rejects(() => read.execute(fileInput, { ...context, task_id: "" }), (error) => error.code === "TOOL_SCOPE_INVALID");
  await assert.rejects(() => read.execute({ ...fileInput, max_chars: 999 }, context), (error) => error.code === "READ_LIMIT_INVALID");
  await assert.rejects(() => read.execute({ ...fileInput, kind: "all" }, context), (error) => error.code === "READ_KIND_INVALID");
  await assert.rejects(() => read.execute(fileInput, { ...context, allowed_file_paths: [".forge/runtime/a"] }), (error) => error.code === "TOOL_SCOPE_INVALID");
  const failing = tool({ readForIndex: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; } });
  await assert.rejects(() => failing.execute(fileInput, context), (error) => error.code === "READ_FILE_NOT_FOUND");
});

test("truncates content at the requested limit and registry is opt-in", async () => {
  const result = await tool().execute({ ...fileInput, max_chars: 1000 }, context);
  assert.equal(result.truncated, false);
  const base = { protocolStorage: { get: async () => ({}) }, fileService: fileService() };
  assert.equal(createForgeToolRegistry(base).read_code, undefined);
  assert.equal(createForgeToolRegistry({ ...base, enableReadCode: true }).read_code.name, "read_code");
});

test("registry applies a default cumulative budget per task", async () => {
  const base = { protocolStorage: { get: async () => ({}) }, fileService: fileService() };
  const registry = createForgeToolRegistry({ ...base, enableReadCode: true, maxChars: 1000 });
  const scoped = { ...context, task_id: "BUDGET-TASK" };
  for (let index = 0; index < 20; index += 1) await registry.read_code.execute({ ...fileInput, max_chars: 1000 }, scoped);
  await assert.rejects(() => registry.read_code.execute({ ...fileInput, max_chars: 1000 }, scoped), (error) => error.code === "CONTEXT_BUDGET_EXCEEDED");
});
