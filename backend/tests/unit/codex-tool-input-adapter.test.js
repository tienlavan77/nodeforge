import assert from "node:assert/strict";
import test from "node:test";
import { createCodexToolInputAdapter } from "../../src/modules/agent/codex-tool-input-adapter.js";

const definitions = [
  { name: "search_code", inputSchema: { type: "object", additionalProperties: false, required: ["query", "kind", "limit", "allowed_prefixes"], properties: { query: { type: "string" }, kind: { enum: ["file", "symbol"] }, limit: { type: "integer" }, allowed_prefixes: { type: "array", items: { type: "string" } }, projection: { enum: ["minimal", "summary", "graph"] } } } },
  { name: "run_test", inputSchema: { type: "object", additionalProperties: false, properties: {} } }
];

test("Codex adapter normalizes only Codex-owned defaults and preserves valid input", () => {
  const adapter = createCodexToolInputAdapter(definitions);
  assert.deepEqual(adapter.normalize("search_code", { query: "Header", kind: "file", limit: 5, allowed_prefixes: ["backend/"] }), { query: "Header", kind: "file", limit: 5, allowed_prefixes: ["backend/"], projection: "minimal" });
});

test("Codex adapter rejects missing, extra, and incorrectly typed arguments", () => {
  const adapter = createCodexToolInputAdapter(definitions);
  assert.throws(() => adapter.normalize("search_code", { query: "Header", kind: "file", allowed_prefixes: ["backend/"] }), (error) => error.code === "TOOL_INPUT_INVALID" && error.details.details.some((item) => item.instance_path === "" && item.keyword === "required"));
  assert.throws(() => adapter.normalize("search_code", { query: "Header", kind: "file", limit: "5", allowed_prefixes: ["backend/"] }), (error) => error.code === "TOOL_INPUT_INVALID");
  assert.throws(() => adapter.normalize("run_test", { command: "rm -rf" }), (error) => error.code === "TOOL_INPUT_INVALID");
});
