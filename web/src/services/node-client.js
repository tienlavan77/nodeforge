export function createNodeClient() {
  return Object.freeze({
    async getAgentSettings() {
      const response = await fetch("/agents/settings");
      if (!response.ok) throw new Error("Node could not load Agent Settings.");
      return response.json();
    },
    async saveAgentSettings(agentId, settings) {
      const response = await fetch(`/agents/${agentId}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Node rejected Agent Settings.");
      return body;
    },
    async testAgentConnection(agentId) {
      const response = await fetch(`/agents/${agentId}/settings/test`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Agent connection failed.");
      return body;
    },
    async postHumanDecision({ projectId, decisionId, actor, proposalId, decision, reason, correlationId }) {
      const response = await fetch(`/projects/${projectId}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision_id: decisionId, type: "human_governance", actor, actor_role: "project_owner", proposal_id: proposalId, decision, ...(reason ? { reason } : {}), correlation_id: correlationId, timestamp: new Date().toISOString() })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Node rejected the Human Decision.");
      return body;
    },
    async getConversationAuditHistory({ projectId, agentId, conversationId, correlationId, type, cursor, limit = 25 }) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (agentId) params.set("agent", agentId);
      if (conversationId) params.set("conversationId", conversationId);
      if (correlationId) params.set("correlationId", correlationId);
      if (type) params.set("type", type);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/projects/${projectId}/history?${params}`);
      if (!response.ok) throw new Error("Node could not load the Conversation and Audit History.");
      return response.json();
    },
    async getProjectDashboard(projectId) {
      const response = await fetch(`/projects/${projectId}/dashboard`);
      if (!response.ok) throw new Error("Node could not load the Project Dashboard.");
      return response.json();
    },
    async getArchitectureWorkspace(projectId) {
      const response = await fetch(`/projects/${projectId}/architecture-workspace`);
      if (!response.ok) throw new Error("Node could not load the Architecture Workspace.");
      return response.json();
    },
    async postOwnerMessage({ projectId, conversationId, messageId, correlationId, text }) {
      const response = await fetch(`/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message_id: messageId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { text } })
      });
      if (!response.ok) throw new Error("Node rejected the owner message.");
      return response.json();
    },
    connectConversationStream({ projectId, conversationId, afterMessageId, onMessage, onError }) {
      if (typeof onMessage !== "function") throw new Error("Conversation stream requires an onMessage handler.");
      const query = afterMessageId ? `?after=${encodeURIComponent(afterMessageId)}` : "";
      const source = new EventSource(`/projects/${projectId}/conversations/${conversationId}/stream${query}`);
      const delivered = new Set();
      source.addEventListener("conversation.message", (event) => {
        const message = JSON.parse(event.data);
        if (delivered.has(message.message_id)) return;
        delivered.add(message.message_id);
        onMessage(message);
      });
      source.onerror = () => onError?.();
      return Object.freeze({ close: () => source.close() });
    },
    sendOwnerMessage(agentId, text) {
      return { id: `local-${Date.now()}`, agentId, text, timestamp: new Date().toISOString() };
    },
    stream: null
  });
}
