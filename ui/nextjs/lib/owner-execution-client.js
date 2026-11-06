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
    },
    // Lists the durable AM-SE-RV state machine without exposing prompts or workspace bytes.
    async listHandoffs(projectId) {
      return requestJson(forgeV1(`/projects/${encodeURIComponent(projectId)}/handoffs`, { project: projectId }), { fallbackError: "Could not load AM-SE-RV handoff checkpoints." });
    },
    // Resumes only the saved handoff step after the backend verifies Owner approval and plan identity.
    async resumeHandoff(projectId, handoff, ownerToken) {
      const conversationId = handoff?.roles?.am?.conversation_id;
      if (!conversationId || !handoff?.handoff_id) throw new Error("Handoff conversation is unavailable.");
      const messageId = `ui-resume-${Date.now()}`;
      const response = await requestJson(forgeV1(`/conversations/${encodeURIComponent(conversationId)}/messages`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId, conversation_id: conversationId, message_id: messageId, correlation_id: messageId, timestamp: new Date().toISOString(), payload: { text: `/resume-se-handoff ${handoff.handoff_id}`, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256 } }), fallbackError: "Could not resume the AM-SE-RV handoff." });
      if (response?.message_type === "owner.command.error") throw new Error(response.payload?.error?.message ?? "Handoff resume was rejected.");
      return response;
    },
    // Requests guarded evidence reconciliation for a handoff that stopped with uncertain execution.
    async resumeCritique(projectId, handoff) {
      return requestJson(forgeV1(`/projects/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(handoff.handoff_id)}/resume`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }), fallbackError: "Could not resume the AM-SE critique checkpoint." });
    },
    async reconcileHandoff(projectId, handoff, ownerToken, operatorApproved = false) {
      return requestJson(forgeV1(`/projects/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(handoff.handoff_id)}/reconcile`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256, operator_approved: operatorApproved }), fallbackError: "Could not reconcile the AM-SE-RV handoff." });
    }
  };
}
