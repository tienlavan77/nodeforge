// Routes authenticated Architecture owner choices without allowing the browser to supply plan approval provenance.
import { randomUUID } from "node:crypto";
import { decisionError } from "../../modules/governance/architecture-owner-decisions.js";

// Loads and confirms only the selected project's conversation-bound clarification sessions.
export async function routeArchitectureClarifications({ method, parts, body, projectId, conversation, headers, ownerChatService, planOwnerAuth }) {
  if (parts[0] !== "conversations" || parts[2] !== "plan-clarifications") return null;
  if (!conversation || conversation.project_id !== projectId) throw decisionError("PROJECT_CONTEXT_CONFLICT", "Clarification conversation is unavailable.");
  const store = ownerChatService?.planningSessions;
  if (!store) throw decisionError("ARCHITECTURE_CLARIFICATIONS_UNAVAILABLE", "Architecture clarification workflow is unavailable.");
  if (method === "GET" && parts.length === 3) return { status: 200, body: await store.list(conversation.id ?? parts[1]) };
  const session = await store.get(parts[3]);
  if (session.project_id !== projectId || session.conversation_id !== parts[1]) throw decisionError("PROJECT_CONTEXT_CONFLICT", "Clarification belongs to another conversation.");
  if (typeof planOwnerAuth?.verify !== "function") throw decisionError("PLAN_OWNER_AUTH_UNCONFIGURED", "Owner authentication is unavailable.");
  const ownerId = planOwnerAuth.verify(headers);
  if (method === "PATCH" && parts.length === 4) return { status: 200, body: await store.update(session.session_id, { expectedVersion: body.version, sourceSha256: body.source_sha256, selections: body.selections, notes: body.notes, cancel: body.cancel === true }) };
  if (method === "POST" && parts.length === 5 && parts[4] === "confirm") {
    const id = randomUUID();
    const response = await ownerChatService.submit({ project_id: projectId, conversation_id: parts[1], agent_id: conversation.agent_id, message_id: `MSG-OWNER-CHOICES-${id}`, correlation_id: `CORR-OWNER-CHOICES-${id}`, sender_id: ownerId, approved_owner_id: ownerId, timestamp: new Date().toISOString(), payload: { text: `/plan-continue ${session.session_id}`, planning_version: body.version, planning_source_sha256: body.source_sha256 } });
    if (response.payload?.error) throw decisionError(response.payload.error.code ?? "PLAN_GENERATION_FAILED", response.payload.error.message ?? "Plan generation failed.");
    return { status: 200, body: response.payload };
  }
  return null;
}
