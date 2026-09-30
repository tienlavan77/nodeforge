// Node control API client and message intent utilities.
import { detectMessageIntent, MESSAGE_INTENTS, normalizeTicketInput } from "./ticket-input.js";
import { createProjectStreamClient } from "./project-stream-client.js";
import { normalizeBackendError } from "./error-normalizer.js";
import { requestJson } from "./node-client-request.js";
import { createTicketHumanReviewClient } from "./ticket-human-review-client.js";

export { detectMessageIntent, MESSAGE_INTENTS, normalizeTicketInput };
// Builds a Forge v1 API URL with query params.
function forgeV1(pathname, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return `${controlApiBase()}/forge/v1${pathname}${search ? `?${search}` : ""}`;
}

// Resolves the control API base URL.
function controlApiBase() {
  const configured = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:3100`;
  }
  return "http://127.0.0.1:3100";
}

// Creates the Node control API client.
export function createNodeClient() {
  const connectProjectStream = createProjectStreamClient(forgeV1);
  return Object.freeze({
    ...createTicketHumanReviewClient({ forgeV1, requestJson }),
    async createConversation({ projectId, agentId, title }) {
      return requestJson(forgeV1("/conversations"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, agent_id: agentId, title }),
        fallbackError: "Node could not create the conversation."
      });
    },

    async listConversations({ projectId, agentId } = {}) {
      return requestJson(forgeV1("/conversations", { project: projectId, ...(agentId ? { agent_id: agentId } : {}) }), { fallbackError: "Node could not load conversations." });
    },

    async getAgents() {
      return requestJson(forgeV1("/agents"), { fallbackError: "Node could not load Agents." });
    },

    async getGitStatus(projectId) {
      return requestJson(forgeV1("/git/status", { project: projectId }), { fallbackError: "Git status is unavailable." });
    },

    async getAgent(agentId) {
      return requestJson(forgeV1(`/agents/${agentId}`), { fallbackError: `Node could not load agent ${agentId}.` });
    },

    async createAgent(settings) {
      return requestJson(forgeV1("/agents"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings), fallbackError: "Node rejected the Agent." });
    },

    async saveAgentSettings(agentId, settings) {
      return requestJson(forgeV1(`/agents/${agentId}`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings), fallbackError: "Node rejected the Agent." });
    },
    async testAgentConnection(agentId) {
      return requestJson(forgeV1(`/agents/${agentId}/test`), { method: "POST", fallbackError: "Agent connection failed." });
    },
    async postHumanDecision({ projectId, decisionId, actor, proposalId, decision, reason, correlationId }) {
      return requestJson(forgeV1(`/projects/${projectId}/decisions`, { project: projectId }), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision_id: decisionId, type: "human_governance", actor, actor_role: "project_owner", proposal_id: proposalId, decision, ...(reason ? { reason } : {}), correlation_id: correlationId, timestamp: new Date().toISOString(), project_id: projectId }),
        fallbackError: "Node rejected the Human Decision."
      });
    },
    async getConversationAuditHistory({ projectId, agentId, conversationId, correlationId, type, cursor, limit = 25, order } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (agentId) params.set("agent", agentId);
      if (conversationId) params.set("conversationId", conversationId);
      if (correlationId) params.set("correlationId", correlationId);
      if (type) params.set("type", type);
      if (cursor) params.set("cursor", cursor);
      if (order) params.set("order", order);
      return requestJson(forgeV1(`/projects/${projectId}/history`, { ...Object.fromEntries(params), project: projectId }), { fallbackError: "Node could not load the Conversation and Audit History." });
    },
    async getProjectDashboard(projectId) {
      return requestJson(forgeV1(`/projects/${projectId}/dashboard`, { project: projectId }), { fallbackError: "Node could not load the Project Dashboard." });
    },
    async getTicket(projectId, ticketId) { return requestJson(forgeV1(`/tickets/${ticketId}`, { project: projectId }), { fallbackError: `Node could not load ticket ${ticketId}.` }); },
    async createTicket(projectId, ticketOrContent, sprintId) {
      const body = typeof ticketOrContent === "string"
        ? { project_id: projectId, sprint_id: sprintId, content: ticketOrContent, context: ticketOrContent }
        : { project_id: projectId, sprint_id: sprintId, ticket: { ...(ticketOrContent ?? {}), sprint_id: ticketOrContent?.sprint_id ?? sprintId } };
      return requestJson(forgeV1("/tickets", { project: projectId }), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), fallbackError: "Node could not create the ticket."
      });
    },
    async getTicketGraph(projectId, ticketId) { return requestJson(forgeV1(`/tickets/${ticketId}/graph`, { project: projectId }), { fallbackError: `Node could not load code graph for ${ticketId}.` }); },
    async uploadSprintPlan(projectId, sprintPlan) {
      return requestJson(forgeV1("/sprints", { project: projectId }), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, sprint_plan: sprintPlan }), fallbackError: "Node rejected the Sprint Plan."
      });
    },
    async listSprints(projectId) {
      return requestJson(forgeV1("/sprints", { project: projectId }), { fallbackError: "Node could not load Sprints." });
    },
    async getSprintPlan(projectId, sprintId) {
      return requestJson(forgeV1(`/sprints/${sprintId}`, { project: projectId }), { fallbackError: "Node could not load the Sprint Plan." });
    },
    async updateSprintPlan(projectId, sprintId, sprintPlan) {
      return requestJson(forgeV1(`/sprints/${sprintId}`, { project: projectId }), {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, sprint_plan: sprintPlan }), fallbackError: "Node could not update the Sprint Plan."
      });
    },
    async addTicketToSprint(projectId, sprintId, ticket) {
      return requestJson(forgeV1(`/sprints/${sprintId}/tickets`, { project: projectId }), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, ticket }), fallbackError: "Node could not add the ticket to the Sprint."
      });
    },
    async deleteSprintPlan(projectId, sprintId) {
      return requestJson(forgeV1(`/sprints/${sprintId}`, { project: projectId }), { method: "DELETE", fallbackError: "Node could not delete the Sprint Plan." });
    },
    async deleteTicket(projectId, ticketId) {
      return requestJson(forgeV1(`/tickets/${ticketId}`, { project: projectId }), { method: "DELETE", fallbackError: "Node could not delete the ticket." });
    },
    async regenerateTicketEnglish(projectId, ticketId, payload = {}) {
      const body = {
        project_id: projectId,
        sprint_id: payload.sprint_id ?? payload.sprintId ?? null,
        context: payload.context ?? payload.original_vietnamese_context ?? payload.vietnamese_context ?? "",
      };
      return requestJson(forgeV1(`/tickets/${ticketId}`, { project: projectId }), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        fallbackError: "Node could not regenerate the English ticket.",
      });
    },
    async runTicket(projectId, ticketId, { fresh = false } = {}) {
      return requestJson(forgeV1(`/tickets/${ticketId}:run`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId, ...(fresh ? { fresh: true } : {}) }), fallbackError: `Node rejected Ticket Run: ${ticketId}.` });
    },
    // Sends the dashboard's coding request to Supervisor without creating a sprint ticket.
    async runCode(projectId, sprintId, text) {
      return requestJson(forgeV1("/code/run", { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId, sprint_id: sprintId, text }), fallbackError: "Node could not run the coder." });
    },
    // Lists unfinished coding sessions for the selected sprint's Resume control.
    async listCodeCheckpoints(projectId, sprintId) {
      return requestJson(forgeV1("/code/checkpoints", { project: projectId, sprint_id: sprintId }), { fallbackError: "Node could not load coding checkpoints." });
    },
    // Continues the original coding request with its saved provider session.
    async resumeCode(projectId, taskId) {
      return requestJson(forgeV1(`/code/${encodeURIComponent(taskId)}/resume`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }), fallbackError: "Node could not resume the coder." });
    },
    async runSprint(projectId, sprintId) {
      return requestJson(forgeV1(`/sprints/${sprintId}/run`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }), fallbackError: "Node could not start the sprint." });
    },
    async runSprintPlan(projectId, sprintId) {
      return requestJson(forgeV1(`/sprints/${sprintId}/run`, { project: projectId }), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }), fallbackError: `Node rejected Sprint Run: ${sprintId}.`
      });
    },
    async getArchitectureWorkspace(projectId) {
      return requestJson(forgeV1(`/projects/${projectId}/architecture-workspace`, { project: projectId }), { fallbackError: "Node could not load the Architecture Workspace." });
    },
    // Chat API canonical route: POST /forge/v1/conversations/:id/messages
    async postOwnerMessage({ projectId, conversationId, agentId, messageId, correlationId, text, intent, ticket }) {
      const messageIntent = intent ?? detectMessageIntent(text);
      if (!Object.values(MESSAGE_INTENTS).includes(messageIntent)) throw new Error("Invalid message intent.");
      const rawText = String(text);
      const normalized = messageIntent === MESSAGE_INTENTS.normalChat ? { text: rawText } : normalizeTicketInput(rawText);
      const ticketObject = ticket ?? normalized.ticket;
      if (messageIntent === MESSAGE_INTENTS.ticketCreate && !ticketObject) throw new Error("Ticket JSON could not be extracted from the message.");
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/messages`, { project: projectId }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, agent_id: agentId, message_id: messageId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { intent: messageIntent, ...(messageIntent === MESSAGE_INTENTS.ticketCreate ? { ticket: ticketObject } : {}), text: rawText } }),
        fallbackError: "Node rejected the owner message."
      });
    },
    async getConversationMessages({ projectId, conversationId, limit = 25, cursor, order } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (conversationId) params.set("conversationId", conversationId);
      if (cursor) params.set("cursor", cursor);
      if (order) params.set("order", order);
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/messages`, { ...Object.fromEntries(params), project: projectId }), { fallbackError: "Node could not load conversation messages." });
    },
    connectConversationStream({ projectId, conversationId, afterMessageId, onMessage, onReplayComplete, onError }) {
      if (typeof onMessage !== "function") throw new Error("Conversation stream requires an onMessage handler.");
      const source = new EventSource(forgeV1("/stream", { project: projectId, ...(afterMessageId ? { after: afterMessageId } : {}) }));
      const delivered = new Set();
      ["conversation.message.owner", "conversation.message.delta", "conversation.message.received", "conversation.tool"].forEach((eventType) => source.addEventListener(eventType, (event) => {
        const message = JSON.parse(event.data);
        if (message.conversation_id && message.conversation_id !== conversationId) return;
        if (delivered.has(message.message_id)) return;
        delivered.add(message.message_id);
        onMessage(message);
      }));
      source.addEventListener("conversation.replay.complete", () => onReplayComplete?.());
      source.onerror = () => onError?.();
      return Object.freeze({ close: () => source.close() });
    },
    connectProjectStream,
    sendOwnerMessage(agentId, text) {
      return { id: `local-${Date.now()}`, agentId, text, timestamp: new Date().toISOString() };
    },
    stream: null
  });
}

// Returns a normalized error-like object for UI toast and inline display.
export function toDisplayError(error) {
  if (!error) return null;
  if (error.code && error.message !== undefined) return error;
  return normalizeBackendError({ body: { error: { message: error.message, code: error.code } }, status: error.status, fallbackError: error.message });
}
