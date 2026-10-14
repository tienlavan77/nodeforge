// Keeps quick-recall owner messages isolated by project and agent without assigning legacy shared history to an unknown sender.
const HISTORY_PREFIX = "nodeforge:project-chat-history";
const MAX_HISTORY = 50;

// Identifies the selected agent's input history without collisions between projects or agent IDs.
export function conversationComposerHistoryKey(projectId, agentId) {
  if (typeof projectId !== "string" || !projectId.trim() || typeof agentId !== "string" || !agentId.trim()) return null;
  return `${HISTORY_PREFIX}:${encodeURIComponent(projectId)}:${encodeURIComponent(agentId)}`;
}

// Filters corrupted entries and bounds each agent's browser history independently.
function normalizeHistory(history) {
  return Array.isArray(history) ? history.filter((item) => typeof item === "string").slice(-MAX_HISTORY) : [];
}

// Restores only the selected agent's history; shared legacy entries have no reliable agent identity.
export function readConversationComposerHistory(key, storage) {
  if (!key) return [];
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    return normalizeHistory(JSON.parse(target?.getItem(key) ?? "[]"));
  } catch (error) { console.warn("Unable to restore agent conversation input history", error); return []; }
}

// Remembers a message locally without duplicate consecutive sends or unbounded growth.
export function appendConversationComposerHistory(history, text) {
  const current = normalizeHistory(history);
  if (typeof text !== "string" || !text.trim() || current[current.length - 1] === text) return current;
  return [...current, text].slice(-MAX_HISTORY);
}

// Saves only one agent's quick-recall inputs and leaves unrelated or legacy history untouched.
export function saveConversationComposerHistory(key, history, storage) {
  if (!key) return;
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    target?.setItem(key, JSON.stringify(normalizeHistory(history)));
  } catch (error) { console.warn("Unable to save agent conversation input history", error); }
}
