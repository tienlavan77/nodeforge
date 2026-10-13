// Sends conversation-scoped Architecture choices without persisting owner credentials in browser storage.

// Creates the clarification client while keeping the main Node client within its size limit.
export function createArchitectureClarificationClient({ forgeV1, requestJson }) {
  // Builds one conversation-bound endpoint so answers cannot accidentally target another planning session.
  const endpoint = (projectId, conversationId, suffix = "") => forgeV1(`/conversations/${encodeURIComponent(conversationId)}/plan-clarifications${suffix}`, { project: projectId });
  return {
    listArchitectureClarifications: (projectId, conversationId) => requestJson(endpoint(projectId, conversationId), { fallbackError: "Không tải được các quyết định Architecture." }),
    saveArchitectureChoices: (projectId, conversationId, session, selections, notes, token, cancel = false) => requestJson(endpoint(projectId, conversationId, `/${session.session_id}`), { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ project_id: projectId, version: session.version, source_sha256: session.source_sha256, selections, notes, cancel }), fallbackError: "Không lưu được lựa chọn. Tải lại phiên mới nhất." }),
    confirmArchitectureChoices: (projectId, conversationId, session, token) => requestJson(endpoint(projectId, conversationId, `/${session.session_id}/confirm`), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ project_id: projectId, version: session.status === "generation_failed" ? session.confirmation_version ?? session.version : session.version, source_sha256: session.source_sha256 }), fallbackError: "Chưa tạo được plan từ các quyết định đã chốt." })
  };
}
