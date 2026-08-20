import { createServer } from "node:http";

import { ConfigurationError } from "../../shared/errors.js";

export function createHttpApi({ runtimeService, ownerChatService, conversationStream, architectureWorkspaceService, projectDashboardService, conversationAuditHistoryService, humanDecisionService } = {}) {
  if (!runtimeService || typeof runtimeService.startTask !== "function" || typeof runtimeService.pauseSession !== "function"
    || typeof runtimeService.resumeSession !== "function" || typeof runtimeService.getSession !== "function" || typeof runtimeService.getProjectMemory !== "function") {
    throw new ConfigurationError("HTTP API requires a Runtime Service.");
  }
  if (ownerChatService !== undefined && typeof ownerChatService?.submit !== "function") throw new ConfigurationError("HTTP API Owner Chat Service must provide submit().");
  if (conversationStream !== undefined && typeof conversationStream?.connect !== "function") throw new ConfigurationError("HTTP API Conversation Stream must provide connect().");
  if (architectureWorkspaceService !== undefined && typeof architectureWorkspaceService?.getWorkspace !== "function") throw new ConfigurationError("HTTP API Architecture Workspace Service must provide getWorkspace().");
  if (projectDashboardService !== undefined && typeof projectDashboardService?.getDashboard !== "function") throw new ConfigurationError("HTTP API Project Dashboard Service must provide getDashboard().");
  if (conversationAuditHistoryService !== undefined && typeof conversationAuditHistoryService?.query !== "function") throw new ConfigurationError("HTTP API Conversation Audit History Service must provide query().");
  if (humanDecisionService !== undefined && typeof humanDecisionService?.submit !== "function") throw new ConfigurationError("HTTP API Human Decision Service must provide submit().");

  return Object.freeze({ handler, createServer: () => createServer(handler) });

  async function handler(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && parts.length === 5 && parts[0] === "projects" && parts[2] === "conversations" && parts[4] === "stream") {
        if (!conversationStream) throw new ConfigurationError("Conversation SSE is not configured.");
        const connection = conversationStream.connect({ projectId: parts[1], conversationId: parts[3], response, afterMessageId: request.headers?.["last-event-id"] ?? url.searchParams.get("after") ?? undefined });
        request.once?.("close", () => connection.close());
        return;
      }
      const result = await route(request.method ?? "GET", url, request);
      writeJson(response, result.status, result.body);
    } catch (error) {
      writeJson(response, error.statusCode ?? 400, { error: error.message });
    }
  }

  async function route(method, url, request) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "conversations" && parts[4] === "messages") {
      if (!ownerChatService) throw new ConfigurationError("Owner Chat API is not configured.");
      const body = await readJson(request);
      return { status: 202, body: ownerChatService.submit({ ...body, project_id: parts[1], conversation_id: parts[3] }) };
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "projects" && parts[2] === "decisions") {
      if (!humanDecisionService) throw new ConfigurationError("Human Decision API is not configured.");
      return { status: 201, body: humanDecisionService.submit({ ...await readJson(request), project_id: parts[1] }) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "architecture-workspace") {
      if (!architectureWorkspaceService) throw new ConfigurationError("Architecture Workspace API is not configured.");
      return { status: 200, body: architectureWorkspaceService.getWorkspace(parts[1]) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "dashboard") {
      if (!projectDashboardService) throw new ConfigurationError("Project Dashboard API is not configured.");
      return { status: 200, body: projectDashboardService.getDashboard(parts[1]) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "history") {
      if (!conversationAuditHistoryService) throw new ConfigurationError("Conversation Audit History API is not configured.");
      return { status: 200, body: conversationAuditHistoryService.query({
        projectId: parts[1], agentId: url.searchParams.get("agent") ?? undefined,
        conversationId: url.searchParams.get("conversationId") ?? undefined, correlationId: url.searchParams.get("correlationId") ?? undefined,
        type: url.searchParams.get("type") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined
      }) };
    }
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
