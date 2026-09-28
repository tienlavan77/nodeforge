// Validates project stream events so live agent occupancy updates reach the Agents page.
export const PROJECT_EVENT_TYPES = Object.freeze(["stream.connected", "stream.snapshot", "watcher.file_indexed", "watcher.file_removed", "ticket.created", "ticket.updated", "ticket.status_changed", "ticket.deleted", "sprint.created", "sprint.updated", "sprint.deleted", "conversation.message.delta", "conversation.message.received", "conversation.message.owner", "conversation.message.created", "conversation.message.completed", "conversation.message.failed", "conversation.agent.status_changed", "agent.status_changed", "agent.checkpoint.updated", "stream.error"]);

// Rejects malformed or cross-project events before updating dashboard state.
export function isProjectStreamEvent(value, projectId) {
  return Boolean(value && typeof value === "object" && typeof value.event_id === "string" && value.event_id.length > 0
    && PROJECT_EVENT_TYPES.includes(value.event_type)
    && value.schema_version === 1 && value.project_id === projectId && typeof value.timestamp === "string"
    && value.payload && typeof value.payload === "object" && !Array.isArray(value.payload));
}
