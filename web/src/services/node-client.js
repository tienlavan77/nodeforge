export function createNodeClient() {
  return Object.freeze({
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
