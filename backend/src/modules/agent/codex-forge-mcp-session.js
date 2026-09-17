// Spawns a short-lived MCP bridge that exposes Forge tools to the Codex CLI over HTTP.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createCodexToolInputAdapter } from "./codex-tool-input-adapter.js";

// Starts a bearer-authenticated MCP HTTP server exposing the given Forge tools.
export async function createCodexForgeMcpSession({ registry, context = {}, definitions = [] } = {}) {
  const token = randomBytes(24).toString("hex");
  const tools = definitions.filter((definition) => typeof registry?.[definition.name]?.execute === "function").map((definition) => ({ name: definition.name, description: definition.description, inputSchema: definition.input_schema }));
  const inputAdapter = createCodexToolInputAdapter(tools);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") return writeJson(response, 404, { error: "not_found" });
    if (request.headers.authorization !== `Bearer ${token}`) return writeJson(response, 401, { error: "unauthorized" });
    try {
      const message = JSON.parse(await readBody(request));
      const result = await handleMessage(message);
      if (message.id !== undefined) writeJson(response, 200, { jsonrpc: "2.0", id: message.id, result });
      else writeJson(response, 202, {});
    } catch (error) {
      const id = (() => { try { return JSON.parse(request.__body ?? "{}").id; } catch { return null; } })();
      writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
    }
  });
  // The Codex CLI may launch its MCP stdio child inside a separate Linux
  // execution namespace. Binding only to that namespace's loopback can make
  // the bridge start successfully while every tools/list request fails.
  // Bind the short-lived, bearer-token-protected session on all local
  // interfaces so the child can reach it in both host and sandbox modes.
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  return Object.freeze({ url: `http://127.0.0.1:${address.port}/mcp`, token, tools, close: () => new Promise((resolve) => server.close(() => resolve())) });

  async function handleMessage(message) {
    if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nodeforge", version: "1.0.0" } };
    if (message.method === "notifications/initialized") return {};
    if (message.method === "tools/list") return { tools };
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const tool = registry?.[name];
      if (!tool || typeof tool.execute !== "function") throw new Error(`Unknown Forge tool: ${name}`);
      try {
        const argumentsInput = inputAdapter.normalize(name, message.params?.arguments ?? {});
        const result = await tool.execute(argumentsInput, context);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: error.code ?? "TOOL_EXECUTION_FAILED", message: error.message, ...(error.details ? { details: error.details } : {}) }) }] };
      }
    }
    throw new Error(`Unsupported MCP method: ${message.method}`);
  }
}

// Reads the full request body from the incoming HTTP stream.
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

// Writes a JSON response with the given status and content-type header.
function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
