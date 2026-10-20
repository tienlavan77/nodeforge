// Exercises the real Codex MCP bridge while a Node-owned report tool waits for verification.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createCodexForgeMcpSession } from "../../src/modules/agent/codex-forge-mcp-session.js";

test("Codex bridge keeps one report request open until Node produces its result", async (t) => {
  let finish;
  let began;
  let calls = 0;
  const waiting = new Promise((resolve) => { began = resolve; });
  const terminal = new Promise((resolve) => { finish = resolve; });
  const session = await createCodexForgeMcpSession({ registry: { report_done: { execute: async () => {
    calls++;
    began();
    await terminal;
    return { summary: "Report verified" };
  } } }, definitions: [{ name: "report_done", input_schema: { type: "object", properties: {} } }] });
  const child = spawn(process.execPath, ["backend/scripts/codex-forge-mcp-bridge.mjs"], { env: {
    ...process.env, NODEFORGE_CODEX_MCP_URL: session.url, NODEFORGE_CODEX_MCP_TOKEN: session.token,
    NODEFORGE_CODEX_MCP_DEFINITIONS: JSON.stringify(session.tools)
  }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => { finish(); child.kill(); lines.close(); await session.close(); });
  const reply = once(lines, "line", { signal: AbortSignal.timeout(5000) });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_done", arguments: { summary: "Done" } } })}\n`);
  await waiting;
  assert.equal(calls, 1);
  finish();
  const [line] = await reply;
  const response = JSON.parse(line);
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.match(JSON.stringify(response.result), /Report verified/);
  assert.equal(calls, 1);
});
