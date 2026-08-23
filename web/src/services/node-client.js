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
    async postOwnerMessage({ projectId, conversationId, agentId, messageId, correlationId, text }) {
      return requestJson(`/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, message_id: messageId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { text } }),
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
