// Routes conversation APIs and decorates dashboard tickets with resumable checkpoints.
import { ConfigurationError } from "../../shared/errors.js";
import { toConversationChatHistory } from "../../agents/agent-contract.js";
import { unavailable } from "./forge-v1-router-utils.js";

// Creates conversation endpoints and checkpoint projections for the Forge API.
export function createForgeV1ConversationRoutes({ conversationCrudService, conversationAuditHistoryService, ownerChatService, listResumableCheckpoints }) {
  return Object.freeze({ routeConversation, withCheckpointSummary, withDashboardCheckpointSummary });

  // Routes conversation CRUD, history, and owner messages.
  async function routeConversation({ method, parts, url, body, projectId }) {
    if (parts[0] === "conversations" && conversationCrudService) {
      if (method === "GET" && parts.length === 1) return { status: 200, body: conversationCrudService.list({ projectId: projectId ?? url.searchParams.get("project_id") ?? undefined, agentId: url.searchParams.get("agent_id") ?? undefined }) };
      if (method === "POST" && parts.length === 1) {
        const payload = { project_id: body.project_id ?? projectId, agent_id: body.agent_id ?? url.searchParams.get("agent_id") ?? undefined, title: body.title };
        return { status: 201, body: conversationCrudService.create(payload) };
      }
      if (method === "POST" && parts.length === 3 && (parts[2] === "pin" || parts[2] === "unpin")) {
        const conversation = conversationCrudService.get(parts[1]);
        if (!conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${parts[1]}.`), { statusCode: 404 });
        if (projectId && conversation.project_id !== projectId) throw Object.assign(new ConfigurationError("Conversation belongs to a different project."), { statusCode: 404 });
        if (parts[2] === "pin") return { status: 200, body: typeof conversationCrudService.pin === "function" ? conversationCrudService.pin(parts[1]) : conversationCrudService.update(parts[1], { pinned: true }) };
        return { status: 200, body: typeof conversationCrudService.unpin === "function" ? conversationCrudService.unpin(parts[1]) : conversationCrudService.update(parts[1], { pinned: false }) };
      }
      if (method === "POST" && parts.length === 3 && parts[2] === "archive") {
        const conversation = conversationCrudService.get(parts[1]);
        if (!conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${parts[1]}.`), { statusCode: 404 });
        if (projectId && conversation.project_id !== projectId) throw Object.assign(new ConfigurationError("Conversation belongs to a different project."), { statusCode: 404 });
        return { status: 200, body: conversationCrudService.update(parts[1], { status: "archived", archived: true, ...body }) };
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "messages") return queryConversationHistory(parts[1], url, projectId, true);
      if (parts.length === 2) {
        const conversation = conversationCrudService.get(parts[1]);
        if (!conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${parts[1]}.`), { statusCode: 404 });
        if (projectId && conversation.project_id !== projectId) throw Object.assign(new ConfigurationError("Conversation belongs to a different project."), { statusCode: 404 });
        if (method === "GET") return { status: 200, body: conversation };
        if (method === "PUT" || method === "PATCH") return { status: 200, body: conversationCrudService.update(parts[1], body) };
        if (method === "DELETE") return { status: 200, body: conversationCrudService.remove(parts[1]) };
      }
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "conversations" && parts[2] === "messages") return queryConversationHistory(parts[1], url, projectId, false);
    if (method === "POST" && parts.length === 3 && parts[0] === "conversations" && parts[2] === "messages") {
      if (!ownerChatService?.submit) throw unavailable("Conversation");
      if (conversationCrudService) {
        const conversation = conversationCrudService.get(parts[1]);
        if (!conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${parts[1]}.`), { statusCode: 404 });
        if (projectId && conversation.project_id !== projectId) throw Object.assign(new ConfigurationError("Conversation belongs to a different project."), { statusCode: 404 });
        if (conversation.status !== "active") throw Object.assign(new ConfigurationError("Conversation is not active."), { statusCode: 409, code: "CONVERSATION_NOT_ACTIVE" });
      }
      return { status: 202, body: await ownerChatService.submit({ ...body, project_id: projectId, conversation_id: parts[1] }) };
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "conversations") {
      if (!ownerChatService?.submit) throw unavailable("Conversation");
      return { status: 202, body: await ownerChatService.submit({ ...body, project_id: body.project_id ?? projectId, conversation_id: body.conversation_id ?? body.conversationId }) };
    }
    return null;
  }

  // Queries persisted conversation messages with the existing project scope rules.
  async function queryConversationHistory(conversationId, url, projectId, requireConversation) {
    if (typeof conversationId !== "string" || conversationId.length === 0) throw Object.assign(new ConfigurationError("Conversation Audit History conversation id is required."), { statusCode: 400 });
    const conversation = conversationCrudService?.get?.(conversationId);
    if (requireConversation && !conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${conversationId}.`), { statusCode: 404 });
    if (conversationCrudService?.get && !conversation) throw Object.assign(new ConfigurationError(`Conversation not found: ${conversationId}.`), { statusCode: 404 });
    if (conversation && projectId && conversation.project_id !== projectId) throw Object.assign(new ConfigurationError("Conversation belongs to a different project."), { statusCode: 404 });
    if (!conversationAuditHistoryService?.query) throw unavailable("Conversation Audit History");
    const history = await conversationAuditHistoryService.query({
      projectId: projectId ?? conversation?.project_id,
      conversationId,
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
      order: url.searchParams.get("order") ?? "asc"
    });
    return { status: 200, body: { ...history, items: toConversationChatHistory(history.items ?? []) } };
  }

  // Adds checkpoint summaries to sprint ticket projections.
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

  // Adds checkpoint summaries to dashboard task projections.
  async function withDashboardCheckpointSummary(dashboard) {
    const byTask = await loadCheckpointMap();
    if (!byTask || !dashboard?.roadmap?.sprints) return dashboard;
    return { ...dashboard, roadmap: { ...dashboard.roadmap, sprints: dashboard.roadmap.sprints.map((sprint) => ({
      ...sprint,
      tasks: (sprint.tasks ?? []).map((task) => {
        const summary = checkpointSummary(byTask, task?.id);
        return summary ? { ...task, checkpoint: summary } : task;
      })
    })) } };
  }

  // Loads resumable execution checkpoints when the optional store is available.
  async function loadCheckpointMap() {
    if (typeof listResumableCheckpoints !== "function") return null;
    let resumable;
    // eslint-disable-next-line no-silent-catch -- Resumable checkpoints are optional; null means none.
    try { resumable = await listResumableCheckpoints(); } catch { return null; }
    return new Map((resumable ?? []).map((checkpoint) => [checkpoint.task_id, checkpoint]));
  }

  // Projects a compact checkpoint summary for a ticket card.
  function checkpointSummary(byTask, ticketId) {
    const checkpoint = byTask?.get(ticketId);
    if (!checkpoint) return null;
    return { resumable: true, last_completed_turn: checkpoint.last_completed_turn ?? 0, last_tool: checkpoint.last_tool ?? null, updated_at: checkpoint.updated_at ?? null };
  }
}
