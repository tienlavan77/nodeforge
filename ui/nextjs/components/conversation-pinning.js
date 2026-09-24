// Keeps pinned conversations at the top of the chat list; provides pin/unpin API helpers and pinned-first ordering.
export function isPinnedConversation(conv) {
  return conv?.pinned === true || conv?.pinned === 1;
}

export function sortPinnedFirst(list) {
  return [...(list ?? [])].sort((a, b) => {
    const pa = isPinnedConversation(a) ? 0 : 1;
    const pb = isPinnedConversation(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ua = a?.updated_at ?? a?.updatedAt ?? "";
    const ub = b?.updated_at ?? b?.updatedAt ?? "";
    if (ua !== ub) return ub < ua ? -1 : 1;
    const ida = String(a?.id ?? a?.conversation_id ?? "");
    const idb = String(b?.id ?? b?.conversation_id ?? "");
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
}

export async function apiPinConversation(id) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  if (!res.ok) { const p = await res.json().catch(() => ({})); throw new Error(p.error ?? p.message ?? "Pin failed"); }
  return res.json().catch(() => ({}));
}

export async function apiUnpinConversation(id) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}/unpin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  if (!res.ok) { const p = await res.json().catch(() => ({})); throw new Error(p.error ?? p.message ?? "Unpin failed"); }
  return res.json().catch(() => ({}));
}
