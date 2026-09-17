// Routes Forge v1 API requests to domain services with checkpoint decoration.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Creates the Forge v1 HTTP router with checkpoint decoration.
export function createForgeV1Router({ dispatchTicket, dispatchSprint, runToolLab, projectStream, projectDashboardService, sprintPlanUploadService, ticketCrudService, ownerChatService, conversationCrudService, conversationAuditHistoryService, architectureWorkspaceService, humanDecisionService, agentSettingsService, listResumableCheckpoints } = {}) {
  return Object.freeze({ route });

  // Adds a compact `checkpoint` summary to each ticket so the UI can show a
  // Resume button when a previous run crashed mid-execution. Checkpoints are
  // retained after report_done (status becomes "completed"), so only pending
  // ones are resumable.
  async function loadCheckpointMap() {
    if (typeof listResumableCheckpoints !== "function") return null;
    let resumable;
    try { resumable = await listResumableCheckpoints(); } catch { return null; }
    return new Map((resumable ?? []).map((checkpoint) => [checkpoint.task_id, checkpoint]));
  }
  function checkpointSummary(byTask, ticketId) {
    const checkpoint = byTask?.get(ticketId);
    if (!checkpoint) return null;
    return { resumable: true, last_completed_turn: checkpoint.last_completed_turn ?? 0, last_tool: checkpoint.last_tool ?? null, updated_at: checkpoint.updated_at ?? null };
  }
  async function withCheckpointSummary(sprints) {
    const byTask = await loadCheckpointMap();
    if (!byTask) return sprints;
    return (sprints ?? []).map((sprint) => ({
      ...sprint,
      tickets: (sprint.tickets ?? []).map((ticket) => {
        const summary = checkpointSummary(byTask, ticket?.id);
        return summary ? { ...ticket, checkpoint: summary } : ticket;
      })
    }));
  }

  // The UI renders ticket cards from the dashboard projection
  // (`dashboard.roadmap.sprints[].tasks`), NOT from GET /sprints, so the
  // checkpoint summary must be decorated here too or Resume/Run fresh never
  // appear. `taskViewSummary` strips unknown fields, so we annotate after the
  // dashboard service returns.
  async function withDashboardCheckpointSummary(dashboard) {
    const byTask = await loadCheckpointMap();
    if (!byTask || !dashboard?.roadmap?.sprints) return dashboard;
    return {
      ...dashboard,
      roadmap: {
        ...dashboard.roadmap,
        sprints: dashboard.roadmap.sprints.map((sprint) => ({
          ...sprint,
          tasks: (sprint.tasks ?? []).map((task) => {
            const summary = checkpointSummary(byTask, task?.id);
            return summary ? { ...task, checkpoint: summary } : task;
          })
        }))
      }
    };
  }
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

    if (parts[0] === "conversations" && conversationCrudService) {
      if (method === "GET" && parts.length === 1) return { status: 200, body: conversationCrudService.list({ projectId: projectId ?? url.searchParams.get("project_id") ?? undefined, agentId: url.searchParams.get("agent_id") ?? undefined }) };
      if (method === "POST" && parts.length === 1) {
        const payload = { project_id: body.project_id ?? projectId, agent_id: body.agent_id ?? url.searchParams.get("agent_id") ?? undefined, title: body.title };
        return { status: 201, body: conversationCrudService.create(payload) };
      }
      if (parts.length === 2) {
        const conversation = conversationCrudService.get(parts[1]);
        if (!conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${parts[1]}.`), { statusCode: 404 });
        if (projectId && conversation.project_id !== projectId) throw Object.assign(new ConfigurationError("Conversation belongs to a different project."), { statusCode: 404 });
        if (method === "GET") return { status: 200, body: conversation };
        if (method === "PUT") return { status: 200, body: conversationCrudService.update(parts[1], body) };
        if (method === "DELETE") return { status: 200, body: conversationCrudService.remove(parts[1]) };
      }
    }

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
      return { status: 200, body: await withDashboardCheckpointSummary(dashboard) };
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
      return { status: 200, body: await withCheckpointSummary(sprints) };
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

    // Chat API: canonical route is POST /forge/v1/conversations (forgeV1("/conversations"))
    if (method === "POST" && parts.length === 1 && parts[0] === "conversations") {
      if (!ownerChatService?.submit) throw unavailable("Conversation");
      return { status: 202, body: await ownerChatService.submit({ ...body, project_id: body.project_id ?? projectId, conversation_id: body.conversation_id ?? body.conversationId }) };
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

// Normalizes a URL pathname into route parts.
function normalizeParts(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "forge" && parts[1] === "v1") return parts.slice(2);
  return parts;
}

// Creates a 503 unavailable error for unconfigured services.
function unavailable(name) {
  return Object.assign(new ConfigurationError(`${name} API is not configured.`), { statusCode: 503 });
}

// RUN resumes from a crash checkpoint by default; `?fresh=true` or a
// `fresh: true` body forces a clean restart that clears prior state.
function runRequestsFresh(url, body) {
  const query = url?.searchParams?.get?.("fresh");
  if (query != null) return query === "true" || query === "1";
  return body?.fresh === true || body?.fresh === "true";
}

// Validates that a project ID is provided.
function requireProject(projectId) {
  if (!projectId) throw Object.assign(new ConfigurationError("Project query parameter is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
}

// Reads and parses a JSON request body.
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
