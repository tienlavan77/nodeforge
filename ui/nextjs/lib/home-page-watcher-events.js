// Normalizes watcher (file-indexing) activity events for the workspace panel's recent-activity feed.

// Normalizes watcher events into a consistent array format.
export function normalizeWatcherEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => Array.isArray(event?.payload?.activity) && event.payload.activity.length > 0)
    .sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
    .slice(-4);
}

// Applies a watcher event to the current state.
export function applyWatcherEvent(current, event) {
  if (event?.event_type === "stream.snapshot") return normalizeWatcherEvents(event.payload?.watcher?.recent_events);
  if (!["watcher.file_indexed", "watcher.file_removed"].includes(event?.event_type) || !Array.isArray(event.payload?.activity)) return current;
  return normalizeWatcherEvents([...current, event]);
}

// Formats a timestamp for message display.
export function displayMessageTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Resolves an agent id to the configured display name used by the chat UI.
export function agentDisplayName(agentId, agents) {
  const agent = agents.find((item) => (item.agent_id ?? item.id) === agentId);
  return agent?.agent_name ?? agent?.name ?? agent?.label ?? agentId ?? "Agent";
}
