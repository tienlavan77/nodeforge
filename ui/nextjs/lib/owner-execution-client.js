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
      return requestJson(forgeV1("/handoffs", { project: projectId }), { fallbackError: "Could not load AM-SE-RV handoff checkpoints." });
    },
    async getHandoff(projectId, handoff) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}`, { project: projectId }), { fallbackError: "Could not load the AM-SE-RV handoff." });
    },
    // Business purpose: shows the Owner whether a saved handoff workspace baseline still matches.
    // Technical description: requests bounded path-level diagnostics from the project-scoped handoff endpoint.
    async getHandoffWorkspace(projectId, handoff) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/workspace`, { project: projectId }), { fallbackError: "Could not inspect handoff workspace." });
    },
    // Business purpose: accepts the current workspace for an untouched first SE checkpoint without discarding files.
    // Technical description: sends exact plan identity and Owner authentication to the guarded baseline adoption endpoint.
    async adoptHandoffWorkspace(projectId, handoff, ownerToken) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/adopt-workspace`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256 }), fallbackError: "Could not adopt current handoff workspace." });
    },
    // Resumes only the saved handoff step after the backend verifies Owner approval and plan identity.
    async runHandoff(projectId, handoff, ownerToken) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/run`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256 }), fallbackError: "Could not run the AM-SE-RV handoff." });
    },
    async resumeHandoff(projectId, handoff, ownerToken) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/resume`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256 }), fallbackError: "Could not resume the AM-SE-RV implementation checkpoint." });
    },
    // Requests guarded evidence reconciliation for a handoff that stopped with uncertain execution.
    async pauseHandoff(projectId, handoff, ownerToken) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/stop`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256 }), fallbackError: "Could not stop the AM-SE-RV handoff." });
    },
    async resumeCritique(projectId, handoff, ownerToken) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/resume-critique`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId }), fallbackError: "Could not resume the AM-SE critique checkpoint." });
    },
    async reconcileHandoff(projectId, handoff, ownerToken, operatorApproved = false) {
      return requestJson(forgeV1(`/handoffs/${encodeURIComponent(handoff.handoff_id)}/reconcile`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json", ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify({ project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256, operator_approved: operatorApproved }), fallbackError: "Could not reconcile the AM-SE-RV handoff." });
    }
  };
}
