export const MESSAGE_INTENTS = Object.freeze({ normalChat: "normal_chat", ticketCreate: "ticket_create", ticketDispatch: "ticket_dispatch" });

export function detectMessageIntent(input) {
  const text = String(input ?? "").trim();
  if (/^\/ticket(?:\s|$)/i.test(text)) return MESSAGE_INTENTS.ticketDispatch;
  const normalized = normalizeTicketInput(text);
  if (normalized.recognized) return MESSAGE_INTENTS.ticketCreate;
  return MESSAGE_INTENTS.normalChat;
}

export function normalizeTicketInput(input) {
  const text = String(input ?? "");
  if (!text.trim()) return { text, normalized_text: "", recognized: false };
  const normalizedText = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const json = extractStructuredJson(normalizedText);
  if (json) {
    const recognized = ["id", "title", "objective", "acceptance_criteria"].some((field) => Object.prototype.hasOwnProperty.call(json, field));
    return { text, normalized_text: normalizedText, recognized, ticket: recognized ? json : undefined, missing: recognized ? requiredTicketFields(json) : [] };
  }
  const hasTicketLabel = /^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(?:title|objective|acceptance[_ ]criteria|criteria|tiêu đề|mục tiêu|tiêu chí)\s*(?:\*\*)?\s*:/im.test(text);
  if (!hasTicketLabel && !/\b(create|tạo|thêm|implement|yêu cầu)\b[\s\S]*\b(ticket|task|công việc)\b/i.test(text)) return { text, normalized_text: normalizedText, recognized: false };
  const normalized = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(title|objective|acceptance[_ ]criteria|criteria|tiêu đề|mục tiêu|tiêu chí)\s*:\s*(?:\*\*)?/i, (_, label) => `${canonicalLabel(label)}:`)).join("\n");
  const fields = new Set([...normalized.matchAll(/^\s*(title|objective|acceptance_criteria)\s*:/gim)].map((match) => match[1].toLowerCase()));
  const missing = ["title", "objective", "acceptance_criteria"].filter((field) => !fields.has(field));
  const ticket = parseLabeledTicket(normalized);
  return { text: normalized, normalized_text: normalizedText, recognized: true, ticket: ticket ?? undefined, missing };
}

function parseLabeledTicket(text) {
  const fields = {};
  for (const match of String(text).matchAll(/^\s*(title|objective|acceptance_criteria)\s*:\s*([\s\S]*?)(?=^\s*(?:title|objective|acceptance_criteria)\s*:|$)/gim)) fields[match[1].toLowerCase()] = match[2].trim();
  if (!fields.title || !fields.objective || !fields.acceptance_criteria) return null;
  return { ...fields, acceptance_criteria: fields.acceptance_criteria.split(/\n|\s*[;|]\s*/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean) };
}

function canonicalLabel(label) {
  const key = label.toLowerCase().replace(/\s+/g, "_");
  return { "tiêu_đề": "title", "mục_tiêu": "objective", "tiêu_chí": "acceptance_criteria", criteria: "acceptance_criteria" }[key] ?? key;
}

function extractStructuredJson(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0; let quoted = false; let escaped = false;
  const opening = text[start]; const closing = opening === "{" ? "}" : "]";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; }
    if (character === '"') quoted = true;
    else if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) { try { const value = JSON.parse(text.slice(start, index + 1)); return value && !Array.isArray(value) ? value : null; } catch { return null; } }
  }
  return null;
}

function requiredTicketFields(value) {
  return ["title", "objective", "acceptance_criteria"].filter((field) => {
    const item = value[field]; return field === "acceptance_criteria" ? !Array.isArray(item) || item.length === 0 : typeof item !== "string" || !item.trim();
  });
}

function forgeV1(pathname, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return `${controlApiBase()}/forge/v1${pathname}${search ? `?${search}` : ""}`;
}

function controlApiBase() {
  const configured = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:3100`;
  }
  return "http://127.0.0.1:3100";
}

export function createNodeClient() {
  return Object.freeze({
    async getAgents() {
      return requestJson(forgeV1("/agents"), { fallbackError: "Node could not load Agents." });
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
    async postOwnerMessage({ projectId, conversationId, agentId, messageId, correlationId, text, intent, ticket }) {
      const messageIntent = intent ?? detectMessageIntent(text);
      if (!Object.values(MESSAGE_INTENTS).includes(messageIntent)) throw new Error("Invalid message intent.");
      const rawText = String(text);
      const normalized = messageIntent === MESSAGE_INTENTS.normalChat ? { text: rawText } : normalizeTicketInput(rawText);
      const ticketObject = ticket ?? normalized.ticket;
      if (messageIntent === MESSAGE_INTENTS.ticketCreate && !ticketObject) throw new Error("Ticket JSON could not be extracted from the message.");
      return requestJson(forgeV1(`/projects/${projectId}/conversations/${conversationId}/messages`, { project: projectId }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, agent_id: agentId, message_id: messageId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { intent: messageIntent, ...(messageIntent === MESSAGE_INTENTS.ticketCreate ? { ticket: ticketObject } : {}), text: rawText } }),
        fallbackError: "Node rejected the owner message."
      });
    },
    connectConversationStream({ projectId, conversationId, afterMessageId, onMessage, onReplayComplete, onError }) {
      if (typeof onMessage !== "function") throw new Error("Conversation stream requires an onMessage handler.");
      const params = new URLSearchParams();
      if (projectId) params.set("project", projectId);
      if (afterMessageId) params.set("after", afterMessageId);
      const query = params.toString() ? `?${params.toString()}` : "";
      const source = new EventSource(`${controlApiBase()}/forge/v1/projects/${projectId}/conversations/${conversationId}/stream${query}`);
      const delivered = new Set();
      const onConversationEvent = (event) => {
        const message = JSON.parse(event.data);
        if (delivered.has(message.message_id)) return;
        delivered.add(message.message_id);
        onMessage(message);
      };
      source.addEventListener("conversation.message", onConversationEvent);
      source.addEventListener("conversation.tool", onConversationEvent);
      source.addEventListener("conversation.replay.complete", () => onReplayComplete?.());
      source.onerror = () => onError?.();
      return Object.freeze({ close: () => source.close() });
    },
    connectProjectStream({ projectId, afterEventId, onEvent, onOpen, onError } = {}) {
      if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Project stream requires a project id.");
      if (typeof onEvent !== "function") throw new Error("Project stream requires an onEvent handler.");
      if (typeof EventSource !== "function") throw new Error("Project stream requires EventSource support.");
      const source = new EventSource(forgeV1("/stream", { project: projectId, ...(afterEventId ? { after: afterEventId } : {}) }));
      const delivered = new Set();
      let lastEventId = afterEventId ?? null;
      const eventTypes = ["stream.connected", "stream.snapshot", "watcher.file_indexed", "watcher.file_removed", "ticket.created", "ticket.updated", "ticket.status_changed", "ticket.deleted", "sprint.created", "sprint.updated", "sprint.deleted", "conversation.message.delta", "conversation.message.received", "conversation.message.owner", "stream.error"];
      const handleEvent = (event) => {
        if (event.lastEventId) lastEventId = event.lastEventId;
        let data;
        try { data = JSON.parse(event.data); } catch { onError?.(new Error("Project stream returned invalid JSON.")); return; }
        if (!isProjectStreamEvent(data, projectId)) { onError?.(new Error("Project stream returned an invalid event.")); return; }
        if (delivered.has(data.event_id)) return;
        delivered.add(data.event_id);
        onEvent(data);
      };
      eventTypes.forEach((eventType) => source.addEventListener(eventType, handleEvent));
      source.onopen = () => onOpen?.();
      source.onerror = (error) => onError?.(error instanceof Error ? error : new Error("Project stream connection failed."));
      return Object.freeze({
        close: () => source.close(),
        getLastEventId: () => lastEventId
      });
    },
    sendOwnerMessage(agentId, text) {
      return { id: `local-${Date.now()}`, agentId, text, timestamp: new Date().toISOString() };
    },
    stream: null
  });
}

function isProjectStreamEvent(value, projectId) {
  return Boolean(value && typeof value === "object" && typeof value.event_id === "string" && value.event_id.length > 0
    && ["stream.connected", "stream.snapshot", "watcher.file_indexed", "watcher.file_removed", "ticket.created", "ticket.updated", "ticket.status_changed", "ticket.deleted", "sprint.created", "sprint.updated", "sprint.deleted", "conversation.message.delta", "conversation.message.received", "conversation.message.owner", "stream.error"].includes(value.event_type)
    && value.schema_version === 1 && value.project_id === projectId && typeof value.timestamp === "string"
    && value.payload && typeof value.payload === "object" && !Array.isArray(value.payload));
}

async function requestJson(url, { fallbackError, ...init } = {}) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("Node is unavailable. Check that the Node service is running.");
  }
  const text = response.status === 204 ? "" : await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) throw new Error("Node returned an invalid response.");
      throw new Error(fallbackError ?? `Node request failed with HTTP ${response.status}.`);
    }
  }
  if (!response.ok) { const error = new Error(body?.error ?? fallbackError ?? `Node request failed with HTTP ${response.status}.`); error.status = response.status; throw error; }
  return body;
}
