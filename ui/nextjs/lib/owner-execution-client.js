// Exposes owner-approved pause and recovery requests for direct System Engineer conversations.

// Builds the scoped execution endpoints used by the System workspace.
export function createOwnerExecutionClient({ forgeV1, requestJson }) {
  return {
    // Lists durable execution states after navigation or a Control API restart.
    async listOwnerExecutions(projectId, conversationId) {
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/executions`, { project: projectId }), { fallbackError: "Could not load System Engineer executions." });
    },
    // Sends an explicit pause, continue, restart, or discard decision to Node.
    async decideOwnerExecution(projectId, conversationId, executionId, action) {
      if (!["pause", "continue", "restart", "discard"].includes(action)) throw new Error("Invalid execution action.");
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/executions/${encodeURIComponent(executionId)}/${action}`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }), fallbackError: `Could not ${action} System Engineer execution.` });
    }
  };
}
