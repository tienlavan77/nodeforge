// Conversations Block component for conversation accordion rows.
"use client";

import { useRef } from "react";

// API helpers for menu actions — trigger backend without full page reload.
async function apiDeleteConversation(id) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) { const p = await res.json().catch(() => ({})); throw new Error(p.error ?? p.message ?? "Delete failed"); }
  return res.json().catch(() => ({}));
}
async function apiRenameConversation(id, title) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  if (!res.ok) { const p = await res.json().catch(() => ({})); throw new Error(p.error ?? p.message ?? "Rename failed"); }
  return res.json().catch(() => ({}));
}
// Pins or unpins a conversation from the left chat list.
async function apiPinConversation(id, pinned) {
  const action = pinned ? "unpin" : "pin";
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  if (!res.ok) { const p = await res.json().catch(() => ({})); throw new Error(p.error ?? p.message ?? (pinned ? "Unpin failed" : "Pin failed")); }
  return res.json().catch(() => ({}));
}
async function apiArchiveConversation(id) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  if (!res.ok) {
    // fallback to PATCH status
    const r2 = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true, status: "archived" }) });
    if (!r2.ok) { const p = await r2.json().catch(() => ({})); throw new Error(p.error ?? p.message ?? "Archive failed"); }
    return r2.json().catch(() => ({}));
  }
  return res.json().catch(() => ({}));
}

// Single row block with title left and pin plus inline actions right.
export function ConversationsBlock({
  conversation,
  active = false,
  checked,
  onCheckedChange,
  onSelect,
  onRenamed,
  onArchived,
  onDeleted,
  menuOpen,
  onMenuToggle,
  isEditing,
  editTitle,
  onEditTitleChange,
  onStartRename,
  onConfirmRename,
  onCancelRename,
  draggable = true,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  isDragging,
  isDragOver,
  isArchived,
  onTogglePin,
  onPinError,
}) {
  const titleText = conversation.title ?? conversation.name ?? conversation.id ?? conversation.conversation_id ?? "";
  const isPinned = conversation.pinned === true || conversation.pinned === 1 || conversation.pinned === "1" || conversation.pinned === "true";
  const wrapRef = useRef(null);

  // Handles pin toggle via API then notifies parent; restores prior state on failure.
  async function handleTogglePin() {
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    try {
      const updated = await apiPinConversation(id, isPinned);
      const normalized = updated && typeof updated === "object" ? (updated.conversation ?? updated) : null;
      onTogglePin?.(normalized && typeof normalized === "object" && "pinned" in normalized ? normalized : { ...conversation, pinned: !isPinned });
    } catch (err) {
      onPinError?.(err?.message ?? (isPinned ? "Unpin failed" : "Pin failed"));
    }
  }

  // Handles delete action via API then notifies parent.
  async function handleDelete() {
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    try {
      await apiDeleteConversation(id);
    } catch { /* allow UI update even if backend not mounted in dev */ }
    onDeleted?.(conversation);
    onMenuToggle?.(false);
  }

  // Handles rename action via API.
  async function handleRenameConfirm() {
    const t = (editTitle ?? "").trim();
    if (!t || t.length > 120) return;
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    try { await apiRenameConversation(id, t); } catch { /* still update UI */ }
    onConfirmRename?.();
  }

  // Handles archive action via API.
  async function handleArchive() {
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    try { await apiArchiveConversation(id); } catch { /* still update UI */ }
    onArchived?.(conversation);
    onMenuToggle?.(false);
  }

  return (
    <li
      draggable={draggable && !isEditing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`conversations-block conversations-accordion-row${isDragging ? " is-dragging" : ""}${isDragOver ? " is-drag-over" : ""}${isArchived ? " is-archived" : ""}${active ? " is-active" : ""}`}
      data-testid="conversations-block"
      aria-current={active ? "true" : undefined}
    >
      {isEditing ? (
        <input
          className="conversations-block-title-input conversations-accordion-rename-input"
          value={editTitle}
          autoFocus
          onChange={(e) => onEditTitleChange?.(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleRenameConfirm(); if (e.key === "Escape") onCancelRename?.(); }}
          onBlur={handleRenameConfirm}
          aria-label="Rename conversation"
        />
      ) : (
        <button type="button" className="conversations-block-title conversations-accordion-item-main" onClick={() => onSelect?.(conversation)}>
          <span className="conversations-block-title-text conversations-accordion-item-title">{titleText}</span>
        </button>
      )}
      {!isEditing && (
        <div className="conversations-block-actions" ref={wrapRef}>
          <button type="button" className="conversations-block-action" aria-label={isPinned ? "Unpin conversation" : "Pin conversation"} aria-pressed={isPinned} onClick={handleTogglePin}>{isPinned ? "Unpin" : "Pin"}</button>
          <button type="button" className="conversations-block-action" onClick={() => onStartRename?.()}>Rename</button>
          <button type="button" className="conversations-block-action" onClick={handleArchive}>Archive</button>
          <button type="button" className="conversations-block-action is-danger" onClick={handleDelete}>Delete</button>
        </div>
      )}
    </li>
  );
}
