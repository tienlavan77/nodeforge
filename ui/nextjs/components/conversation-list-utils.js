// Loads and orders the left chat list so pinned conversations stay on top across reloads.
const STORAGE_ORDER_KEY = "nodeforge:conversations:order";

// Returns stable id for conversation
export function getConversationId(conv) {
  return String(conv.id ?? conv.conversation_id ?? conv.conversationId ?? conv.title ?? Math.random());
}

// Applies a locally stored drag order on top of fetched conversations.
export function applyStoredOrder(list) {
  let next = [...(list ?? [])];
  try {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_ORDER_KEY) : null;
    if (stored) {
      const order = JSON.parse(stored);
      if (Array.isArray(order) && order.length) {
        const map = new Map(next.map((c) => [getConversationId(c), c]));
        const ordered = [];
        for (const id of order) { if (map.has(id)) { ordered.push(map.get(id)); map.delete(id); } }
        for (const [, v] of map) ordered.push(v);
        next = ordered;
      }
    }
  } catch { /* ignore */ }
  return next;
}

// Removes duplicate conversation rows by stable id.
export function dedupeConversations(list) {
  const deduped = [];
  const seen = new Set();
  for (const c of list ?? []) {
    const id = getConversationId(c);
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(c);
  }
  return deduped;
}

// Persists current order to localStorage
export function persistOrder(list) {
  try { window.localStorage.setItem(STORAGE_ORDER_KEY, JSON.stringify((list ?? []).map(getConversationId))); } catch { /* ignore */ }
}

// Normalizes a list API payload into an array of conversations.
export function normalizeConversationPayload(payload) {
  let fetched = payload.conversations ?? payload.data ?? payload.items ?? payload.results ?? payload;
  if (!Array.isArray(fetched)) {
    if (fetched && Array.isArray(fetched.conversations)) fetched = fetched.conversations;
    else if (fetched && typeof fetched === "object" && fetched !== null) fetched = [];
    else fetched = [];
  }
  return fetched;
}

// Fetches the persisted conversation list from the API so pinned state survives reloads.
export async function fetchConversationList({ projectId, agentId } = {}) {
  const params = new URLSearchParams();
  if (projectId != null && projectId !== "") params.set("project_id", String(projectId));
  if (agentId != null && agentId !== "") params.set("agent_id", String(agentId));
  const qs = params.toString();
  const url = qs ? `/forge/v1/conversations?${qs}` : "/forge/v1/conversations";
  const response = await fetch(url, { method: "GET", headers: { "content-type": "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? "Unable to load conversations.");
  return normalizeConversationPayload(payload);
}

// Sends a create-conversation request to the Forge API and returns the created conversation.
export async function createConversationRequest(title, { onNewConversation, projectId, agentId } = {}) {
  const body = { title, project_id: projectId, agent_id: agentId };
  const response = await fetch("/forge/v1/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? "Unable to create conversation.");
  const conversation = payload.conversation ?? payload;
  if (onNewConversation) return onNewConversation(title, conversation);
  return conversation;
}
