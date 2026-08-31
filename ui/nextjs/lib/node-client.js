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
  return { text: normalized, normalized_text: normalizedText, recognized: true, missing };
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

export function createNodeClient() {
  return Object.freeze({
    async getAgentSettings() {
      return requestJson("/agents/settings", { fallbackError: "Node could not load Agent Settings." });
    },
    async saveAgentSettings(agentId, settings) {
      return requestJson(`/agents/${agentId}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings), fallbackError: "Node rejected Agent Settings." });
    },
    async testAgentConnection(agentId) {
      return requestJson(`/agents/${agentId}/settings/test`, { method: "POST", fallbackError: "Agent connection failed." });
    },
    async postHumanDecision({ projectId, decisionId, actor, proposalId, decision, reason, correlationId }) {
      return requestJson(`/projects/${projectId}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision_id: decisionId, type: "human_governance", actor, actor_role: "project_owner", proposal_id: proposalId, decision, ...(reason ? { reason } : {}), correlation_id: correlationId, timestamp: new Date().toISOString() }),
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
      return requestJson(`/projects/${projectId}/history?${params}`, { fallbackError: "Node could not load the Conversation and Audit History." });
    },
    async getProjectDashboard(projectId) {
      return requestJson(`/projects/${projectId}/dashboard`, { fallbackError: "Node could not load the Project Dashboard." });
    },
    async uploadSprintPlan(projectId, sprintPlan) {
      return requestJson(`/projects/${projectId}/sprint-plans`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sprint_plan: sprintPlan }), fallbackError: "Node rejected the Sprint Plan."
      });
    },
    async getSprintPlan(projectId, sprintId) {
      return requestJson(`/projects/${projectId}/sprint-plans/${sprintId}`, { fallbackError: "Node could not load the Sprint Plan." });
    },
    async deleteSprintPlan(projectId, sprintId) {
      return requestJson(`/projects/${projectId}/sprint-plans/${sprintId}`, { method: "DELETE", fallbackError: "Node could not delete the Sprint Plan." });
    },
    async deleteTicket(projectId, ticketId) {
      return requestJson(`/projects/${projectId}/tickets/${ticketId}`, { method: "DELETE", fallbackError: "Node could not delete the ticket." });
    },
    async runSprint(projectId, sprintId) {
      return requestJson(`/projects/${projectId}/sprint-plans/${sprintId}/run`, { method: "POST", fallbackError: "Node could not start the sprint." });
    },
    async runSprintPlan(projectId, sprintId) {
      return requestJson(`/projects/${projectId}/sprint-plans/${sprintId}/run`, {
        method: "POST", fallbackError: `Node rejected Sprint Run: ${sprintId}.`
      });
    },
    async getArchitectureWorkspace(projectId) {
      return requestJson(`/projects/${projectId}/architecture-workspace`, { fallbackError: "Node could not load the Architecture Workspace." });
    },
    async postOwnerMessage({ projectId, conversationId, agentId, messageId, correlationId, text, intent, ticket }) {
      const messageIntent = intent ?? detectMessageIntent(text);
      if (!Object.values(MESSAGE_INTENTS).includes(messageIntent)) throw new Error("Invalid message intent.");
      const rawText = String(text);
      const normalized = messageIntent === MESSAGE_INTENTS.normalChat ? { text: rawText } : normalizeTicketInput(rawText);
      const ticketObject = ticket ?? normalized.ticket;
      console.log("ticket", normalized.ticket ?? null);
      if (messageIntent === MESSAGE_INTENTS.ticketCreate && !ticketObject) throw new Error("Ticket JSON could not be extracted from the message.");
      return requestJson(`/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, message_id: messageId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { intent: messageIntent, ...(messageIntent === MESSAGE_INTENTS.ticketCreate ? { ticket: ticketObject } : {}), text: rawText } }),
        fallbackError: "Node rejected the owner message."
      });
    },
    connectConversationStream({ projectId, conversationId, afterMessageId, onMessage, onReplayComplete, onError }) {
      if (typeof onMessage !== "function") throw new Error("Conversation stream requires an onMessage handler.");
      const query = afterMessageId ? `?after=${encodeURIComponent(afterMessageId)}` : "";
      const source = new EventSource(`/projects/${projectId}/conversations/${conversationId}/stream${query}`);
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
    sendOwnerMessage(agentId, text) {
      return { id: `local-${Date.now()}`, agentId, text, timestamp: new Date().toISOString() };
    },
    stream: null
  });
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
