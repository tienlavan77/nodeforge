import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

export function createForgeV1Router({ dispatchTicket, dispatchSprint, projectDashboardService, sprintPlanUploadService, ownerChatService, conversationAuditHistoryService, architectureWorkspaceService, humanDecisionService, agentSettingsService } = {}) {
  return Object.freeze({ route });

  async function route(method, url, request) {
    const parts = normalizeParts(url.pathname);
    const requestId = request.headers?.["x-request-id"] ?? randomUUID();
    const correlationId = request.headers?.["x-correlation-id"] ?? requestId;
    const body = method === "POST" || method === "PUT" || method === "PATCH" ? await readJson(request) : {};

    const queryProject = url.searchParams.get("project") ?? undefined;
    const bodyProject = body.project_id ?? body.project ?? undefined;
    if (bodyProject && queryProject && bodyProject !== queryProject) {
      throw Object.assign(new ConfigurationError("Project context differs between query and payload."), {
        statusCode: 409,
        code: "PROJECT_CONTEXT_CONFLICT"
      });
    }

    const projectId = bodyProject ?? queryProject;

    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      return { status: 200, body: { status: "ok", service: "nodeforge" } };
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "version") {
      return { status: 200, body: { api: "forge/v1", service: "nodeforge" } };
    }

    if (parts[0] === "agents") {
      if (!agentSettingsService) throw unavailable("Agent Settings");
      if (method === "GET" && parts.length === 1) return { status: 200, body: agentSettingsService.list() };
      if (method === "POST" && parts.length === 1) return { status: 201, body: agentSettingsService.create(body) };
      if (method === "GET" && parts.length === 2) return { status: 200, body: agentSettingsService.get(parts[1]) };
      if (method === "PUT" && parts.length === 2) return { status: 200, body: agentSettingsService.save({ ...body, agent_id: parts[1] }) };
      if (method === "DELETE" && parts.length === 2) return { status: 200, body: agentSettingsService.remove(parts[1]) };
      if (method === "POST" && parts.length === 3 && parts[2] === "test") return { status: 200, body: await agentSettingsService.testConnection(parts[1]) };
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "projects" && parts[2] === "decisions") {
      if (!humanDecisionService) throw unavailable("Human Decision");
      return { status: 201, body: humanDecisionService.submit({ ...body, project_id: parts[1], correlation_id: body.correlation_id ?? correlationId }) };
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "dashboard") {
      if (!projectDashboardService?.getDashboard) throw unavailable("Project Dashboard");
      return { status: 200, body: await projectDashboardService.getDashboard(parts[1]) };
    }

    if (method === "GET" && parts.length === 4 && parts[0] === "projects" && parts[2] === "tickets") {
      if (!projectDashboardService?.getTicket) throw unavailable("Ticket Detail");
      return { status: 200, body: await projectDashboardService.getTicket(parts[1], parts[3]) };
    }

    if (method === "GET" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4] === "graph") {
      if (!projectDashboardService?.getTicketGraph) throw unavailable("Ticket Code Graph");
      return { status: 200, body: await projectDashboardService.getTicketGraph(parts[1], parts[3]) };
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "history") {
      if (!conversationAuditHistoryService?.query) throw unavailable("Conversation Audit History");
      return { status: 200, body: await conversationAuditHistoryService.query({
        projectId: parts[1],
        agentId: url.searchParams.get("agent") ?? undefined,
        conversationId: url.searchParams.get("conversationId") ?? undefined,
        correlationId: url.searchParams.get("correlationId") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        order: url.searchParams.get("order") ?? undefined
      }) };
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "projects" && parts[2] === "history") {
      if (!conversationAuditHistoryService?.query) throw unavailable("Conversation Audit History");
      return { status: 200, body: await conversationAuditHistoryService.query({
        projectId: parts[1],
        agentId: body.agent_id ?? url.searchParams.get("agent") ?? undefined,
        conversationId: body.conversation_id ?? url.searchParams.get("conversationId") ?? undefined,
        correlationId: body.correlation_id ?? url.searchParams.get("correlationId") ?? undefined,
        type: body.type ?? url.searchParams.get("type") ?? undefined,
        cursor: body.cursor ?? url.searchParams.get("cursor") ?? undefined,
        limit: body.limit ?? (url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined),
        order: body.order ?? url.searchParams.get("order") ?? undefined
      }) };
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "architecture-workspace") {
      if (!architectureWorkspaceService?.getWorkspace) throw unavailable("Architecture Workspace");
      return { status: 200, body: architectureWorkspaceService.getWorkspace(projectId) };
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "projects" && parts[2] === "architecture-workspace") {
      if (!architectureWorkspaceService?.getWorkspace) throw unavailable("Architecture Workspace");
      return { status: 200, body: architectureWorkspaceService.getWorkspace(parts[1]) };
    }

    if (method === "POST" && parts.length === 1 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.upload) throw unavailable("Sprint Plan Upload");
      return { status: 201, body: sprintPlanUploadService.upload({ projectId, sprintPlan: body.sprint_plan ?? body }) };
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.list) throw unavailable("Sprint Plan List");
      return { status: 200, body: sprintPlanUploadService.list({ projectId }) };
    }

    if (method === "GET" && parts.length === 2 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.get) throw unavailable("Sprint Plan View");
      return { status: 200, body: sprintPlanUploadService.get({ projectId, sprintId: parts[1] }) };
    }

    if (method === "PUT" && parts.length === 2 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.update) throw unavailable("Sprint Plan Update");
      return { status: 200, body: sprintPlanUploadService.update({ projectId, sprintId: parts[1], sprintPlan: body.sprint_plan ?? body }) };
    }

    if (method === "DELETE" && parts.length === 2 && parts[0] === "sprints") {
      if (!sprintPlanUploadService?.remove) throw unavailable("Sprint Plan Delete");
      return { status: 200, body: sprintPlanUploadService.remove({ projectId, sprintId: parts[1] }) };
    }

    if (method === "DELETE" && parts.length === 4 && parts[0] === "projects" && parts[2] === "tickets") {
      if (!sprintPlanUploadService?.removeTicket) throw unavailable("Ticket Delete");
      return { status: 200, body: sprintPlanUploadService.removeTicket({ projectId: parts[1], ticketId: parts[3] }) };
    }

    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4] === "run") {
      if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
      const result = await dispatchTicket({ projectId: parts[1], ticketId: parts[3], conversationId: "CONV-BUILDER" });
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "tickets" && parts[1].endsWith(":run")) {
      if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
      const result = await dispatchTicket({ projectId, ticketId: parts[1].slice(0, -4), conversationId: "CONV-BUILDER" });
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "sprints" && parts[2] === "run") {
      const runSprint = dispatchSprint;
      if (typeof runSprint !== "function") throw unavailable("Sprint Orchestration");
      const result = await runSprint({ projectId, sprintId: parts[1] });
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "sprints" && parts[1].endsWith(":run")) {
      const runSprint = dispatchSprint;
      if (typeof runSprint !== "function") throw unavailable("Sprint Orchestration");
      const result = await runSprint({ projectId, sprintId: parts[1].slice(0, -4) });
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "projects" && parts[2] === "conversations") {
      if (!ownerChatService?.submit) throw unavailable("Conversation");
      return { status: 202, body: await ownerChatService.submit({ ...body, project_id: parts[1] }) };
    }

    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "conversations" && parts[4] === "messages") {
      if (!ownerChatService?.submit) throw unavailable("Conversation");
      return { status: 202, body: await ownerChatService.submit({ ...body, project_id: parts[1], conversation_id: parts[3] }) };
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "conversations" && parts[2] === "messages") {
      if (!ownerChatService?.submit) throw unavailable("Conversation");
      return { status: 202, body: await ownerChatService.submit({ ...body, project_id: projectId, conversation_id: parts[1] }) };
    }

    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4].endsWith(":run")) {
      if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
      return { status: 202, body: await dispatchTicket({ projectId: parts[1], ticketId: parts[3] ?? parts[4].slice(0, -4), conversationId: "CONV-BUILDER" }) };
    }

    throw Object.assign(new ConfigurationError("Route not found."), { statusCode: 404 });
  }
}

function normalizeParts(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "forge" && parts[1] === "v1") return parts.slice(2);
  return parts;
}

function unavailable(name) {
  return Object.assign(new ConfigurationError(`${name} API is not configured.`), { statusCode: 503 });
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigurationError("Request body must be valid JSON.");
  }
}

