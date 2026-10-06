// Exposes owner-approved pause and recovery requests for direct System Engineer conversations.

// Builds the scoped execution endpoints used by the System workspace.
export function createOwnerExecutionClient({ forgeV1, requestJson }) {
  return {
    // Lists durable execution states after navigation or a Control API restart.
    async listOwnerExecutions(projectId, conversationId, ownerToken) {
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/executions`, { project: projectId }), { headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}, fallbackError: "Could not load conversation executions." });
    },
    // Sends an explicit pause, continue, restart, or discard decision to Node.
    async decideOwnerExecution(projectId, conversationId, executionId, action, ownerToken) {
      if (!["pause", "continue", "restart", "discard"].includes(action)) throw new Error("Invalid execution action.");
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/executions/${encodeURIComponent(executionId)}/${action}`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId }), fallbackError: `Could not ${action} conversation execution.` });
    },
    // Asks Node to verify the intended document state before an Architecture recovery decision.
    async reconcileOwnerExecution(projectId, conversationId, executionId, sequence, ownerToken) {
      return requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/executions/${encodeURIComponent(executionId)}/reconcile`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId, sequence }), fallbackError: "Document state cannot be verified for recovery." });
    }
  };
}
