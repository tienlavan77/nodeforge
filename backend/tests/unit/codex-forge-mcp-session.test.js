import assert from "node:assert/strict";
import test from "node:test";
import { createCodexForgeMcpSession } from "../../src/modules/agent/codex-forge-mcp-session.js";

test("Codex MCP session advertises inputSchema and normalizes tool-call input", async () => {
  const calls = [];
  const session = await createCodexForgeMcpSession({
    registry: { search_code: { execute: async (input) => { calls.push(input); return { ok: true }; } } },
    definitions: [{ name: "search_code", description: "Search", input_schema: { type: "object", additionalProperties: false, required: ["query", "kind", "limit", "allowed_prefixes"], properties: { query: { type: "string" }, kind: { enum: ["file", "symbol"] }, limit: { type: "integer" }, allowed_prefixes: { type: "array", items: { type: "string" } }, projection: { enum: ["minimal", "summary", "graph"] } } } }]
  });
  try {
    const list = await fetch(session.url, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((response) => response.json());
    assert.equal(list.result.tools[0].inputSchema.type, "object");
    const result = await fetch(session.url, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_code", arguments: { query: "Header", kind: "file", limit: 5, allowed_prefixes: ["backend/"] } } }) }).then((response) => response.json());
    assert.equal(result.result.content[0].text, JSON.stringify({ ok: true }));
    assert.equal(calls[0].projection, "minimal");
    const invalid = await fetch(session.url, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_code", arguments: { query: "Header", kind: "file", limit: "5", allowed_prefixes: ["backend/"] } } }) }).then((response) => response.json());
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /TOOL_INPUT_INVALID/);
  } finally {
    await session.close();
  }
});
