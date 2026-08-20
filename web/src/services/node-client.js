export function createNodeClient() {
  return Object.freeze({
    async postOwnerMessage({ projectId, conversationId, messageId, correlationId, text }) {
      const response = await fetch(`/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message_id: messageId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { text } })
      });
      if (!response.ok) throw new Error("Node rejected the owner message.");
      return response.json();
    },
    sendOwnerMessage(agentId, text) {
      return { id: `local-${Date.now()}`, agentId, text, timestamp: new Date().toISOString() };
    },
    stream: null
  });
}
