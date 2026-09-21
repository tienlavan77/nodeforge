// Creates the HTTP API server handling SSE streams and JSON routes.
import { createServer } from "node:http";

import { ConfigurationError } from "../../shared/errors.js";

// Creates the HTTP API handler with SSE and route support.
export function createHttpApi({ ownerChatService, conversationStream, projectStream, architectureWorkspaceService, projectDashboardService, conversationAuditHistoryService, humanDecisionService, agentSettingsService, sprintPlanUploadService, sprintOrchestrationService, dispatchSprint, dispatchTicket, ticketRunner, forgeV1Router } = {}) {
  if (ownerChatService !== undefined && typeof ownerChatService?.submit !== "function") throw new ConfigurationError("HTTP API Owner Chat Service must provide submit().");
  if (conversationStream !== undefined && typeof conversationStream?.connect !== "function") throw new ConfigurationError("HTTP API Conversation Stream must provide connect().");
  if (architectureWorkspaceService !== undefined && typeof architectureWorkspaceService?.getWorkspace !== "function") throw new ConfigurationError("HTTP API Architecture Workspace Service must provide getWorkspace().");
  if (projectDashboardService !== undefined && typeof projectDashboardService?.getDashboard !== "function") throw new ConfigurationError("HTTP API Project Dashboard Service must provide getDashboard().");
  if (conversationAuditHistoryService !== undefined && typeof conversationAuditHistoryService?.query !== "function") throw new ConfigurationError("HTTP API Conversation Audit History Service must provide query().");
  if (humanDecisionService !== undefined && typeof humanDecisionService?.submit !== "function") throw new ConfigurationError("HTTP API Human Decision Service must provide submit().");
  if (agentSettingsService !== undefined && (typeof agentSettingsService?.list !== "function" || typeof agentSettingsService?.save !== "function" || typeof agentSettingsService?.testConnection !== "function")) throw new ConfigurationError("HTTP API Agent Settings Service must provide list(), save(), and testConnection().");
  if (sprintPlanUploadService !== undefined && typeof sprintPlanUploadService?.upload !== "function") throw new ConfigurationError("HTTP API Sprint Plan Upload Service must provide upload().");
  if (sprintOrchestrationService !== undefined && typeof sprintOrchestrationService?.run !== "function") throw new ConfigurationError("HTTP API Sprint Orchestration Service must provide run().");
  if (dispatchSprint !== undefined && typeof dispatchSprint !== "function") throw new ConfigurationError("HTTP API Sprint Dispatch must be a function.");

  return Object.freeze({ handler, createServer: () => createServer(handler) });
  async function handler(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const origin = request.headers?.origin;
      if (request.method === "OPTIONS") {
        applyCorsHeaders(response, origin);
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname.startsWith("/forge/v1/")) {
        const parts = url.pathname.split("/").filter(Boolean).slice(2);
        if (request.method === "GET" && parts.length === 1 && parts[0] === "stream") {
          if (!projectStream) throw new ConfigurationError("Project SSE is not configured.");
          const projectId = url.searchParams.get("project");
          if (!projectId) throw Object.assign(new ConfigurationError("Project query parameter is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
          applyCorsHeaders(response, origin, true);
          const connection = projectStream.connect({ requestedProjectId: projectId, response, afterEventId: request.headers?.["last-event-id"] ?? url.searchParams.get("after") ?? undefined });
          request.once?.("close", () => connection.close());
          return;
        }
        if (forgeV1Router) {
          const result = await forgeV1Router.route(request.method ?? "GET", url, request, {
            ownerChatService,
            conversationStream,
            architectureWorkspaceService,
            projectDashboardService,
            conversationAuditHistoryService,
            humanDecisionService,
            agentSettingsService,
            sprintPlanUploadService,
            sprintOrchestrationService,
            dispatchSprint,
            dispatchTicket,
            ticketRunner
          });
          writeJson(response, result.status, result.body, origin);
          return;
        }
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const result = await route(request.method ?? "GET", url, request);
      writeJson(response, result.status, result.body, origin);
    } catch (error) {
      // SSE may have already sent headers before a disconnect/error; never
      // attempt a second response that would crash the Control API process.
      if (!response.headersSent && !response.writableEnded) writeJson(response, error.statusCode ?? 400, { error: error.message }, request.headers?.origin);
      else response.destroy?.();
    }
  }
  async function route(method, url, request) {
    const parts = url.pathname.split("/").filter(Boolean);
    const projectId = url.searchParams.get("project") ?? undefined;
    if (method === "POST" && parts.length === 3 && parts[0] === "projects" && parts[2] === "decisions") {
      if (!humanDecisionService) throw new ConfigurationError("Human Decision API is not configured.");
      return { status: 201, body: humanDecisionService.submit({ ...await readJson(request), project_id: parts[1] }) };
    }
    if (method === "GET" && parts.length === 2 && parts[0] === "agents" && parts[1] === "settings") {
      if (!agentSettingsService) throw new ConfigurationError("Agent Settings API is not configured.");
      return { status: 200, body: agentSettingsService.list() };
    }
    if (method === "PUT" && parts.length === 3 && parts[0] === "agents" && parts[2] === "settings") {
      if (!agentSettingsService) throw new ConfigurationError("Agent Settings API is not configured.");
      return { status: 200, body: agentSettingsService.save({ ...await readJson(request), agent_id: parts[1] }) };
    }
    if (method === "POST" && parts.length === 4 && parts[0] === "agents" && parts[2] === "settings" && parts[3] === "test") {
      if (!agentSettingsService) throw new ConfigurationError("Agent Settings API is not configured.");
      return { status: 200, body: await agentSettingsService.testConnection(parts[1]) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "architecture-workspace") {
      if (!architectureWorkspaceService) throw new ConfigurationError("Architecture Workspace API is not configured.");
      return { status: 200, body: architectureWorkspaceService.getWorkspace(parts[1]) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "dashboard") {
      if (!projectDashboardService) throw new ConfigurationError("Project Dashboard API is not configured.");
      return { status: 200, body: await projectDashboardService.getDashboard(parts[1]) };
    }
    if (method === "GET" && parts.length === 4 && parts[0] === "projects" && parts[2] === "tickets") {
      if (!projectDashboardService?.getTicket) throw new ConfigurationError("Ticket Detail API is not configured.");
      return { status: 200, body: await projectDashboardService.getTicket(parts[1], parts[3]) };
    }
    if (method === "GET" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4] === "graph") {
      if (!projectDashboardService?.getTicketGraph) throw new ConfigurationError("Ticket Code Graph API is not configured.");
      return { status: 200, body: await projectDashboardService.getTicketGraph(parts[1], parts[3]) };
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "sprints") {
      if (!sprintPlanUploadService) throw new ConfigurationError("Sprint Plan Upload API is not configured.");
      const body = await readJson(request, { maxBytes: 5 * 1024 * 1024 });
      return { status: 201, body: sprintPlanUploadService.upload({ projectId, sprintPlan: body.sprint_plan ?? body }) };
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.list) throw new ConfigurationError("Sprint Plan List API is not configured.");
      return { status: 200, body: sprintPlanUploadService.list({ projectId }) };
    }

    if (method === "GET" && parts.length === 2 && parts[0] === "sprints") {
      if (!sprintPlanUploadService || typeof sprintPlanUploadService.get !== "function") throw new ConfigurationError("Sprint Plan View API is not configured.");
      return { status: 200, body: sprintPlanUploadService.get({ projectId, sprintId: parts[1] }) };
    }
    if (method === "PUT" && parts.length === 2 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.update) throw new ConfigurationError("Sprint Plan Update API is not configured.");
      const body = await readJson(request);
      return { status: 200, body: sprintPlanUploadService.update({ projectId, sprintId: parts[1], sprintPlan: body.sprint_plan ?? body }) };
    }

    if (method === "DELETE" && parts.length === 2 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.remove) throw new ConfigurationError("Sprint Plan Delete API is not configured.");
      return { status: 200, body: sprintPlanUploadService.remove({ projectId, sprintId: parts[1] }) };
    }
    if (method === "DELETE" && parts.length === 4 && parts[0] === "projects" && parts[2] === "tickets") {
      if (!sprintPlanUploadService?.removeTicket) throw new ConfigurationError("Ticket Delete API is not configured.");
      return { status: 200, body: sprintPlanUploadService.removeTicket({ projectId: parts[1], ticketId: parts[3] }) };
    }
    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4] === "run") {
      const runDispatch = dispatchTicket ?? ticketRunner;
      if (typeof runDispatch !== "function") throw new ConfigurationError("Ticket Dispatch API is not configured.");
      return { status: 202, body: await runDispatch({ projectId: parts[1], ticketId: parts[3], conversationId: "CONV-BUILDER" }) };
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "sprints" && parts[2] === "run") {
      const runSprint = dispatchSprint ?? sprintOrchestrationService?.run;
      if (typeof runSprint !== "function") throw new ConfigurationError("Sprint Orchestration API is not configured.");
      return { status: 202, body: await runSprint({ projectId, sprintId: parts[1] }) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "history") {
      if (!conversationAuditHistoryService) throw new ConfigurationError("Conversation Audit History API is not configured.");
      return { status: 200, body: await conversationAuditHistoryService.query({
        projectId: parts[1], agentId: url.searchParams.get("agent") ?? undefined,
        conversationId: url.searchParams.get("conversationId") ?? undefined, correlationId: url.searchParams.get("correlationId") ?? undefined,
        type: url.searchParams.get("type") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        ...(url.searchParams.has("order") ? { order: url.searchParams.get("order") } : {})
      }) };
    }
    const error = new ConfigurationError("Route not found.");
    error.statusCode = 404;
    throw error;
  }
}

// Writes a JSON response with CORS headers.
function writeJson(response, status, body, origin) {
  applyCorsHeaders(response, origin);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Applies CORS headers to the response.
function applyCorsHeaders(response, origin, sse = false) {
  const allowedOrigin = origin ?? "*";
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-request-id,x-correlation-id,last-event-id");
  response.setHeader("access-control-expose-headers", "content-type,x-request-id,x-correlation-id");
  response.setHeader("vary", "Origin");
  if (sse) {
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
  }
}


// Reads and parses a JSON request body.
async function readJson(request, { maxBytes = 1024 * 1024 } = {}) {
  let body = "";
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) {
      const error = new ConfigurationError(`Request body exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
      error.statusCode = 413;
      throw error;
    }
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ConfigurationError("Request body must be valid JSON.");
  }
}
