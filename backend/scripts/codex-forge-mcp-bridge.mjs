import readline from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const endpoint = process.env.NODEFORGE_CODEX_MCP_URL;
const token = process.env.NODEFORGE_CODEX_MCP_TOKEN;
const definitions = JSON.parse(process.env.NODEFORGE_CODEX_MCP_DEFINITIONS ?? "[]");
if (!endpoint || !token) throw new Error("NodeForge Codex MCP bridge requires endpoint configuration.");
const debugLogPath = process.env.NODEFORGE_CODEX_MCP_DEBUG_LOG;
function debug(message, details) {
  if (!debugLogPath) return;
  // eslint-disable-next-line no-silent-catch -- Diagnostics must never break the MCP stdio transport.
  try { mkdirSync(dirname(debugLogPath), { recursive: true }); appendFileSync(debugLogPath, `${new Date().toISOString()} ${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}\n`); } catch { /* diagnostics must never break MCP */ }
}
debug("started", { pid: process.pid, tool_count: definitions.length });

// Codex 0.154 advertises the 2026-07-28 MCP dialect.  Keeping this bridge
// deliberately small avoids the version cap of the generic MCP SDK bundled
// with NodeForge while preserving the standard JSON-RPC stdio transport.
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const errorResult = (id, code, message) => output({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  // eslint-disable-next-line no-silent-catch -- Malformed input maps to a JSON-RPC error response; no server log needed.
  try { message = JSON.parse(line); } catch { return errorResult(null, -32700, "Invalid JSON."); }
  debug("request", { method: message.method, id: message.id, tool: message.params?.name });
  if (message.id === undefined) {
    if (message.method === "notifications/initialized") return;
    return;
  }
  try {
    const result = await handle(message);
    output({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    debug("error", { method: message.method, message: error.message });
    errorResult(message.id, error.code ?? -32603, error.message);
  }
});

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2026-07-28",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "nodeforge", version: "1.0.0" }
    };
  }
  if (message.method === "tools/list") return { tools: definitions };
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const definition = definitions.find((item) => item.name === name);
    if (!definition) return { isError: true, content: [{ type: "text", text: `Unknown Forge tool: ${name}` }] };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: message.params?.arguments ?? {} } })
    });
    debug("node_response", { name, status: response.status });
    const raw = await response.text();
    let body;
    // eslint-disable-next-line no-silent-catch -- Upstream error payload maps to an MCP error response; no server log needed.
    try { body = raw ? JSON.parse(raw) : {}; } catch { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: "MCP_INVALID_RESPONSE", message: `Forge MCP returned invalid JSON (HTTP ${response.status}).` }) }] }; }
    if (!response.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: "MCP_HTTP_ERROR", message: body?.error ?? `Forge MCP returned HTTP ${response.status}.` }) }] };
    if (body.error) return { isError: true, content: [{ type: "text", text: body.error.message }] };
    return body.result ?? { content: [{ type: "text", text: "{}" }] };
  }
  throw Object.assign(new Error(`Unsupported MCP method: ${message.method}`), { code: -32601 });
}
