// Routes Forge v1 API requests to domain services with checkpoint decoration.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { createForgeV1ConversationRoutes } from "./forge-v1-conversation-routes.js";
import { normalizeParts, unavailable, runRequestsFresh, requireProject, readJson } from "./forge-v1-router-utils.js";

// Creates the Forge v1 HTTP router with checkpoint decoration.
export function createForgeV1Router({ dispatchTicket, dispatchSprint, runToolLab, projectStream, projectDashboardService, sprintPlanUploadService, ticketCrudService, ownerChatService, conversationCrudService, conversationAuditHistoryService, architectureWorkspaceService, humanDecisionService, agentSettingsService, listResumableCheckpoints } = {}) {
  const conversationRoutes = createForgeV1ConversationRoutes({ conversationCrudService, conversationAuditHistoryService, ownerChatService, listResumableCheckpoints });
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
    const conversationResult = await conversationRoutes.routeConversation({ method, parts, url, body, projectId });
    if (conversationResult) return conversationResult;

    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      return { status: 200, body: { status: "ok", service: "nodeforge" } };
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "version") {
      return { status: 200, body: { api: "forge/v1", service: "nodeforge" } };
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "stream" && parts[1] === "events") {
      if (!projectStream?.ingest) throw unavailable("Project Stream");
      if (!body.project_id) throw Object.assign(new ConfigurationError("project_id is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
      const result = projectStream.ingest(body);
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
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
      const dashboard = await projectDashboardService.getDashboard(parts[1]);
      return { status: 200, body: await conversationRoutes.withDashboardCheckpointSummary(dashboard) };
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
      const sprints = sprintPlanUploadService.list({ projectId });
      return { status: 200, body: await conversationRoutes.withCheckpointSummary(sprints) };
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

    if (parts[0] === "tickets" && (parts.length === 1 || (parts.length === 2 && !parts[1].endsWith(":run")))) {
      if (parts.length === 1) {
        requireProject(projectId);
        if (method === "GET") {
          if (!ticketCrudService?.listTickets) throw unavailable("Ticket List");
          return { status: 200, body: ticketCrudService.listTickets({ projectId }) };
        }
        if (method === "POST") {
          if (!ticketCrudService?.createTicket) throw unavailable("Ticket Create");
          return { status: 201, body: await ticketCrudService.createTicket({ projectId, ticket: body.ticket, content: body.content, sprintId: body.sprint_id, ...(body.context !== undefined ? { context: body.context } : {}) }) };
        }
      }
      if (parts.length === 2) {
        requireProject(projectId);
        if (method === "GET") {
          if (!projectDashboardService?.getTicket) throw unavailable("Ticket Detail");
          return { status: 200, body: await projectDashboardService.getTicket(projectId, parts[1]) };
        }
        if (method === "PUT") {
          if (body.context !== undefined && ticketCrudService?.regenerateTicketEnglish) {
            return { status: 200, body: await ticketCrudService.regenerateTicketEnglish({ projectId, ticketId: parts[1], context: body.context, sprintId: body.sprint_id }) };
          }
          if (!ticketCrudService?.updateTicket) throw unavailable("Ticket Update");
          return { status: 200, body: ticketCrudService.updateTicket({ projectId, ticketId: parts[1], patch: body.ticket ?? body }) };
        }
        if (method === "DELETE") {
          if (!sprintPlanUploadService?.removeTicket) throw unavailable("Ticket Delete");
          return { status: 200, body: sprintPlanUploadService.removeTicket({ projectId, ticketId: parts[1] }) };
        }
      }
    }

    if (method === "DELETE" && parts.length === 4 && parts[0] === "projects" && parts[2] === "tickets") {
      if (!sprintPlanUploadService?.removeTicket) throw unavailable("Ticket Delete");
      return { status: 200, body: sprintPlanUploadService.removeTicket({ projectId: parts[1], ticketId: parts[3] }) };
    }

    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4] === "run") {
      if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
      const result = await dispatchTicket({ projectId: parts[1], ticketId: parts[3], conversationId: "CONV-BUILDER", ...(runRequestsFresh(url, body) ? { fresh: true } : {}) });
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "tickets" && parts[1].endsWith(":run")) {
      if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
      const result = await dispatchTicket({ projectId, ticketId: parts[1].slice(0, -4), conversationId: "CONV-BUILDER", ...(runRequestsFresh(url, body) ? { fresh: true } : {}) });
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

    if (method === "POST" && parts.length === 1 && parts[0] === "tool-lab") {
      if (typeof runToolLab !== "function") throw unavailable("Tool Lab");
      const normalizedPrefixes = body.allowed_prefixes ?? body.allowedPrefixes ?? (typeof body.allowed_prefix === "string" ? [body.allowed_prefix] : undefined);
      const toolTest = typeof body.tool_test === "object" && body.tool_test !== null ? body.tool_test : {};
      const result = await runToolLab({ projectId, targetPath: toolTest.target_path ?? body.target_path ?? body.targetPath, allowedPrefixes: toolTest.allowed_prefixes ?? normalizedPrefixes, approvalPolicy: toolTest.approval_policy, taskId: body.task_id ?? body.taskId });
      return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
    }

    if (method === "POST" && parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && parts[4].endsWith(":run")) {
      if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
      return { status: 202, body: await dispatchTicket({ projectId: parts[1], ticketId: parts[3] ?? parts[4].slice(0, -4), conversationId: "CONV-BUILDER", ...(runRequestsFresh(url, body) ? { fresh: true } : {}) }) };
    }

    throw Object.assign(new ConfigurationError("Route not found."), { statusCode: 404 });
  }
}

// RUN resumes from a crash checkpoint by default; `?fresh=true` or a
// `fresh: true` body forces a clean restart that clears prior state.
