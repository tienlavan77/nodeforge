// Conversations Block component for conversation accordion rows.
"use client";

import { useRef, useState } from "react";

// API helpers for menu actions — trigger backend without full page reload.
async function apiDeleteConversation(id) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  return readActionResponse(res, "Delete failed");
}
async function apiRenameConversation(id, title) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  return readActionResponse(res, "Rename failed");
}
// Pins or unpins a conversation from the left chat list.
async function apiPinConversation(id, pinned) {
  const action = pinned ? "unpin" : "pin";
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  return readActionResponse(res, pinned ? "Unpin failed" : "Pin failed");
}
async function apiArchiveConversation(id) {
  const res = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  if (!res.ok && [404, 405, 501].includes(res.status)) {
    // fallback to PATCH status
    const fallback = await fetch(`/forge/v1/conversations/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true, status: "archived" }) });
    const updated = await readActionResponse(fallback, "Archive failed");
    if ((updated.conversation ?? updated).status !== "archived") throw new Error("Archive was not persisted");
    return updated;
  }
  const updated = await readActionResponse(res, "Archive failed");
  if ((updated.conversation ?? updated).status !== "archived") throw new Error("Archive was not persisted");
  return updated;
}

// Read action results without turning API or malformed-response failures into success.
async function readActionResponse(response, message) {
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : message);
  return payload;
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
  const pendingRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);

  // Prevent duplicate mutations and expose failed conversation actions without success callbacks.
  async function runAction(action, failureMessage) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setActionError("");
    try {
      await action();
    } catch (error) {
      const message = error?.message ?? failureMessage;
      setActionError(message);
      if (failureMessage.toLowerCase().includes("pin")) onPinError?.(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  // Handles pin toggle via API then notifies parent; restores prior state on failure.
  async function handleTogglePin() {
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    await runAction(async () => {
      const updated = await apiPinConversation(id, isPinned);
      const normalized = updated && typeof updated === "object" ? (updated.conversation ?? updated) : null;
      onTogglePin?.(normalized && typeof normalized === "object" && "pinned" in normalized ? normalized : { ...conversation, pinned: !isPinned });
    }, isPinned ? "Unpin failed" : "Pin failed");
  }

  // Handles delete action via API then notifies parent.
  async function handleDelete() {
    if (pendingRef.current || !window.confirm(`Delete conversation "${titleText}"? This cannot be undone.`)) return;
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    await runAction(async () => {
      await apiDeleteConversation(id);
      onDeleted?.(conversation);
      onMenuToggle?.(false);
    }, "Delete failed");
  }

  // Handles rename action via API.
  async function handleRenameConfirm() {
    if (cancelRenameRef.current) return;
    const title = (editTitle ?? "").trim();
    if (!title || title.length > 120) return;
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    await runAction(async () => {
      await apiRenameConversation(id, title);
      onConfirmRename?.();
    }, "Rename failed");
  }

  // Handles archive action via API.
  async function handleArchive() {
    const id = String(conversation.id ?? conversation.conversation_id ?? "");
    await runAction(async () => {
      await apiArchiveConversation(id);
      onArchived?.(conversation);
      onMenuToggle?.(false);
    }, "Archive failed");
  }

  return (
    <li
      draggable={draggable && !isEditing && !pending}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`conversations-block conversations-accordion-row${isDragging ? " is-dragging" : ""}${isDragOver ? " is-drag-over" : ""}${isArchived ? " is-archived" : ""}${active ? " is-active" : ""}${checked ? " is-selected" : ""}`}
      data-testid="conversations-block"
      aria-current={active ? "true" : undefined}
    >
      {isEditing ? (
        <input
          className="conversations-block-title-input conversations-accordion-rename-input"
          value={editTitle}
          autoFocus
          onChange={(event) => onEditTitleChange?.(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") { event.preventDefault(); handleRenameConfirm(); }
            if (event.key === "Escape") { event.preventDefault(); cancelRenameRef.current = true; onCancelRename?.(); }
          }}
          onBlur={handleRenameConfirm}
          aria-label="Rename conversation"
          aria-busy={pending}
        />
      ) : (
        <button type="button" className="conversations-block-title conversations-accordion-item-main" onClick={() => onSelect?.(conversation)}>
          <span className="conversations-block-title-text conversations-accordion-item-title">{titleText}</span>
        </button>
      )}
      {!isEditing && (
        <div className="conversations-block-actions" ref={wrapRef} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
          <button type="button" disabled={pending} className="conversations-block-action" title={isPinned ? "Unpin conversation" : "Pin conversation"} aria-label={isPinned ? "Unpin conversation" : "Pin conversation"} aria-pressed={isPinned} onClick={handleTogglePin}><svg aria-hidden="true" viewBox="0 0 24 24"><path d={isPinned ? "M4 4l16 16M9 3h6l-1 6 4 4v2H6v-2l4-4M12 15v7" : "M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6M12 15v7"} /></svg></button>
          <button type="button" disabled={pending} className="conversations-block-action" title="Rename conversation" aria-label="Rename conversation" onClick={() => { cancelRenameRef.current = false; onStartRename?.(); }}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 16L16 4l4 4L8 20H4v-4M14 6l4 4" /></svg></button>
          <button type="button" disabled={pending} className="conversations-block-action" title="Archive conversation" aria-label="Archive conversation" onClick={handleArchive}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 4h18v4H3zM5 8v12h14V8M9 12h6" /></svg></button>
          <button type="button" disabled={pending} className="conversations-block-action is-danger" title="Delete conversation" aria-label="Delete conversation" onClick={handleDelete}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></button>
        </div>
      )}
      {actionError && <span className="conversations-block-error" role="alert">{actionError}</span>}
    </li>
  );
}
