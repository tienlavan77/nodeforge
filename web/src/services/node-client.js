export function createNodeClient() {
  return Object.freeze({
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
