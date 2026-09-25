// Persists and restores the owner's active conversation selection, and generates client-side ids for new chat messages.

// Reads the last chat selection so reload can restore the same conversation.
export function readChatState(key) {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Persists the active agent and conversation for the next page load.
export function writeChatState(key, agentId, conversationId) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify({ agent_id: agentId, conversation_id: conversationId })); } catch { /* storage is optional */ }
}

// Checks whether a conversation id is compatible with the persisted conversation API.
export function isPersistedConversationId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));
}

// Creates a globally unique client identifier for chat tracing and deduplication.
export function createChatId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `${prefix}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
