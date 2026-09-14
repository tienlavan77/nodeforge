import assert from "node:assert/strict";
import test from "node:test";

import { createForgeSdkMcpServer } from "../../src/tools/claude-sdk-forge-tools.js";

async function callTool(server, name, args) {
  const handler = server.instance.server._requestHandlers.get("tools/call");
  return handler({ method: "tools/call", params: { name, arguments: args } }, {});
}

test("forge SDK MCP tools accept omitted optional arguments without the SDK nonoptional error", async () => {
  const received = [];
  const registry = {
    select_code_graph_candidates: { execute: async (input) => { received.push(["select", input]); return { candidates: [] }; } },
    search_code: { execute: async (input) => { received.push(["search", input]); return { matches: [] }; } },
    edit_diff: { execute: async (input) => { received.push(["edit", input]); return {}; } }
  };
  const server = createForgeSdkMcpServer({ registry, context: { task_id: "T-OPT" } });

  const select = await callTool(server, "select_code_graph_candidates", { query: "find selector files" });
  assert.equal(select.isError, undefined);
  assert.deepEqual(received[0], ["select", { query: "find selector files", limit: 4 }]);

  const search = await callTool(server, "search_code", { query: "x", allowed_prefixes: ["ui/"] });
  assert.equal(search.isError, undefined);
  assert.deepEqual(received[1], ["search", { query: "x", allowed_prefixes: ["ui/"], kind: "file", limit: 10, projection: "minimal" }]);

  const edit = await callTool(server, "edit_diff", { path: "a.txt", before_checksum: null, anchor: "x", replacement: "y" });
  assert.equal(edit.isError, undefined);
  assert.deepEqual(received[2], ["edit", { path: "a.txt", before_checksum: null, anchor: "x", replacement: "y", occurrence: "first" }]);
});

test("forge SDK MCP write_diff still converts the string 'null' before_checksum", async () => {
  const received = [];
  const registry = {
    write_diff: { execute: async (input) => { received.push(input); return { ok: true }; } }
  };
  const server = createForgeSdkMcpServer({ registry, context: { task_id: "T-WD" } });

  const result = await callTool(server, "write_diff", { path: "a.txt", content: "hi", before_checksum: "null" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(received[0], { path: "a.txt", content: "hi", before_checksum: null });
});

test("forge SDK MCP tool errors stay structured with error_code", async () => {
  const registry = {
    report_done: { execute: async () => { const error = new Error("bad summary"); error.code = "REPORT_INVALID"; throw error; } }
  };
  const server = createForgeSdkMcpServer({ registry, context: { task_id: "T-ERR" } });

  const result = await callTool(server, "report_done", { summary: "x" });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error_code, "REPORT_INVALID");
  assert.equal(payload.message, "bad summary");
});
