import assert from "node:assert/strict";
import test from "node:test";
import { createReadCodeTool } from "../../src/tools/read-code.js";
import { createSearchCodeTool } from "../../src/tools/search-code.js";
import { createReadTranscriptBlocksTool } from "../../src/tools/read-transcript-blocks.js";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/select-code-graph-candidates.js";

test("read_code enforces the Node-owned cumulative retrieval budget and emits audit", async () => {
  const content = "const value = 1;";
  const tool = createReadCodeTool({ fileService: { readForIndex: async () => ({ path: "src/a.js", content, language: "javascript", sha256: "sha256:x", size_bytes: content.length }) } });
  const audit = [];
  const context = { task_id: "T", capabilities: ["read_code"], allowed_file_paths: ["src/a.js"], context_budget: { max_bytes: 10000, max_calls: 1, used_bytes: 0, used_calls: 0 }, audit_retrieval: (entry) => audit.push(entry) };
  await tool.execute({ kind: "file", path: "src/a.js", symbol: null, start_line: null, end_line: null, max_chars: 1000 }, context);
  assert.equal(context.context_budget.used_calls, 1);
  assert.equal(audit[0].tool, "read_code");
  await assert.rejects(() => tool.execute({ kind: "file", path: "src/a.js", symbol: null, start_line: null, end_line: null, max_chars: 1000 }, context), (error) => error.code === "CONTEXT_BUDGET_EXCEEDED");
});

test("search_code rejects a retrieval that exceeds Node budget", async () => {
  const tool = createSearchCodeTool({ codeSearch: { search: async () => ({ index_version: "IDX", matches: [] }) } });
  await assert.rejects(() => tool.execute({ query: "Header", kind: "file", limit: 10, allowed_prefixes: ["src/"] }, { task_id: "T", capabilities: ["search_code"], allowed_prefixes: ["src/"], context_budget: { max_bytes: 100, max_calls: 2, used_bytes: 0, used_calls: 0 } }), (error) => error.code === "CONTEXT_BUDGET_EXCEEDED");
});

test("read_transcript_blocks applies budget before reading files", async () => {
  const tool = createReadTranscriptBlocksTool({ protocolStorage: { get: async () => ({ data: {} }) }, fileService: { readForIndex: async () => ({ path: "src/a.js", content: "x", language: "javascript" }) }, maxChars: 1000 });
  await assert.rejects(() => tool.execute({ block_ids: [], rounds: [], file_paths: ["src/a.js"], include: "both", max_chars: 1000 }, { task_id: "T", capabilities: ["read_transcript_blocks"], allowed_file_paths: ["src/a.js"], context_budget: { max_bytes: 10, max_calls: 1, used_bytes: 0, used_calls: 0 } }), (error) => error.code === "CONTEXT_BUDGET_EXCEEDED");
});

test("all tools reject a mismatched current execution scope", async () => {
  const scope = { task_id: "T", execution_scope: { task_id: "OTHER" } };
  const graph = createSelectCodeGraphCandidatesTool();
  await assert.rejects(() => graph.execute({ selected: [{ path: "src/a.js", reason: "x" }] }, { ...scope, capabilities: ["select_code_graph_candidates"], candidates: [{ path: "src/a.js", score: 1 }] }), (error) => error.code === "TOOL_SCOPE_INVALID");
});
