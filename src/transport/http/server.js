import { createServer } from "node:http";

import { ConfigurationError } from "../../shared/errors.js";

export function createHttpApi({ runtimeService } = {}) {
  if (!runtimeService || typeof runtimeService.startTask !== "function" || typeof runtimeService.pauseSession !== "function"
    || typeof runtimeService.resumeSession !== "function" || typeof runtimeService.getSession !== "function" || typeof runtimeService.getProjectMemory !== "function") {
    throw new ConfigurationError("HTTP API requires a Runtime Service.");
  }

  return Object.freeze({ handler, createServer: () => createServer(handler) });

  async function handler(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const result = await route(request.method ?? "GET", url, request);
      writeJson(response, result.status, result.body);
    } catch (error) {
      writeJson(response, error.statusCode ?? 400, { error: error.message });
    }
  }

  async function route(method, url, request) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && parts.length === 1 && parts[0] === "tasks") {
      return { status: 201, body: runtimeService.startTask(await readJson(request)) };
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "pause") {
      return { status: 200, body: runtimeService.pauseSession(parts[1]) };
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "resume") {
      return { status: 200, body: runtimeService.resumeSession(parts[1]) };
    }
    if (method === "GET" && parts.length === 2 && parts[0] === "sessions") {
      return { status: 200, body: runtimeService.getSession(parts[1]) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "memory") {
      const taskId = url.searchParams.get("taskId") ?? parts[1];
      const query = url.searchParams.get("query") ?? "";
      const domain = url.searchParams.get("domain") ?? undefined;
      return { status: 200, body: runtimeService.getProjectMemory({ projectId: parts[1], taskId, query, domain }) };
    }
    const error = new ConfigurationError("Route not found.");
    error.statusCode = 404;
    throw error;
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ConfigurationError("Request body must be valid JSON.");
  }
}
