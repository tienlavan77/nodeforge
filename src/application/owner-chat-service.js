import { ConfigurationError } from "../shared/errors.js";

export function createOwnerChatService({ bus, architectureManagerId = "architecture-manager" } = {}) {
  if (typeof bus?.send !== "function") throw new ConfigurationError("Owner Chat Service requires the shared Communication Bus.");
  const messages = new Map();

  return Object.freeze({ submit });

  function submit(input) {
    assertMessage(input);
    const existing = messages.get(input.message_id);
    if (existing) return { ...structuredClone(existing), duplicate: true };
    const message = {
      id: input.message_id,
      project_id: input.project_id,
      sender: { id: input.sender_id ?? "project-owner", role: "project_owner" },
      recipient: { id: architectureManagerId, role: "architecture_manager" },
      message_type: "owner.message",
      conversation_id: input.conversation_id,
      correlation_id: input.correlation_id,
      payload: { text: input.payload.text },
      timestamp: input.timestamp
    };
    // Bus persists via the canonical Communication Store before dispatching.
    const persisted = bus.send(message);
    messages.set(persisted.id, Object.freeze(structuredClone(persisted)));
    return structuredClone(persisted);
  }
}

function assertMessage(input) {
  if (!input || typeof input !== "object" || typeof input.message_id !== "string" || input.message_id.length === 0
    || typeof input.project_id !== "string" || input.project_id.length === 0 || typeof input.conversation_id !== "string" || input.conversation_id.length === 0
    || typeof input.correlation_id !== "string" || input.correlation_id.length === 0 || typeof input.timestamp !== "string"
    || typeof input.payload?.text !== "string" || input.payload.text.trim().length === 0) {
    throw new ConfigurationError("Owner message requires message_id, project_id, conversation_id, correlation_id, timestamp, and text.");
  }
}
