// Conversations accordion with interactive rows and drag-and-drop reordering.
"use client";

import { useState, useEffect, useRef } from "react";
import { CreateConversationModal } from "./CreateConversationModal.jsx";
import { ConversationsBlock } from "./ConversationsBlock.jsx";

const STORAGE_ORDER_KEY = "nodeforge:conversations:order";

// Returns stable id for conversation
function getConversationId(conv) {
  return String(conv.id ?? conv.conversation_id ?? conv.conversationId ?? conv.title ?? Math.random());
}

// Sends a create-conversation request to the Forge API and returns the created conversation.
async function createConversationRequest(title, { onNewConversation, projectId, agentId } = {}) {
  const body = { title, project_id: projectId, agent_id: agentId };
  const response = await fetch("/forge/v1/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? "Unable to create conversation.");
  const conversation = payload.conversation ?? payload;
  if (onNewConversation) return onNewConversation(title, conversation);
  return conversation;
}

// Renders the collapsible conversations list with new-conversation action.
export function ConversationsAccordion({
  conversations = [],
  onNewConversation,
  onSelectConversation,
  activeConversationId = null,
  defaultOpen = false,
  projectId,
  agentId,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState(() => [...conversations]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const menuRef = useRef(null);
  const fetchedKeyRef = useRef(null);

  useEffect(() => {
    let next = [...conversations];
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
    setItems(next);
  }, [conversations]);

  // Fetch conversations on page load filtered by project_id and agent_id
  useEffect(() => {
    const key = `${projectId ?? ""}::${agentId ?? ""}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;
    let cancelled = false;
    // Fetches conversations from Forge API and updates items state
    async function fetchConversations() {
      setLoading(true);
      setFetchError("");
      try {
        const params = new URLSearchParams();
        if (projectId != null && projectId !== "") params.set("project_id", String(projectId));
        if (agentId != null && agentId !== "") params.set("agent_id", String(agentId));
        const qs = params.toString();
        const url = qs ? `/forge/v1/conversations?${qs}` : "/forge/v1/conversations";
        const response = await fetch(url, { method: "GET", headers: { "content-type": "application/json" } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? payload.message ?? "Unable to load conversations.");
        let fetched = payload.conversations ?? payload.data ?? payload.items ?? payload.results ?? payload;
        if (!Array.isArray(fetched)) {
          if (fetched && Array.isArray(fetched.conversations)) fetched = fetched.conversations;
          else if (fetched && typeof fetched === "object" && fetched !== null) fetched = [];
          else fetched = [];
        }
        if (cancelled) return;
        // Deduplicate by id and apply stored order
        const deduped = [];
        const seen = new Set();
        for (const c of fetched) {
          const id = getConversationId(c);
          if (seen.has(id)) continue;
          seen.add(id);
          deduped.push(c);
        }
        let next = deduped;
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
        setItems(next);
      } catch (err) {
        if (cancelled) return;
        setFetchError(err?.message ?? "Unable to load conversations.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchConversations();
    return () => { cancelled = true; };
  }, [projectId, agentId]);

  // Persists current order to localStorage
  function persistOrder(list) {
    try { window.localStorage.setItem(STORAGE_ORDER_KEY, JSON.stringify(list.map(getConversationId))); } catch { /* ignore */ }
  }

  useEffect(() => {
    if (menuOpenId === null) return;
    const onDown = (e) => {
      const wraps = document.querySelectorAll(".conversations-accordion-menu-wrap");
      let inside = false;
      wraps.forEach((w) => { if (w.contains(e.target)) inside = true; });
      if (!inside) setMenuOpenId(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpenId]);

  // Appends or updates a conversation row after create
  function upsertConversation(conversation) {
    const id = getConversationId(conversation);
    setItems((prev) => {
      const idx = prev.findIndex((c) => getConversationId(c) === id);
      let next;
      if (idx >= 0) { next = [...prev]; next[idx] = { ...prev[idx], ...conversation }; }
      else { next = [...prev, conversation]; }
      persistOrder(next);
      return next;
    });
  }

  // Validates and creates a new conversation.
  async function handleCreateConversation(event) {
    event?.preventDefault();
    if (creating) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Conversation title is required.");
      return;
    }
    if (trimmedTitle.length > 120) {
      setError("Conversation title must be 120 characters or fewer.");
      return;
    }
    setError("");
    setCreating(true);
    try {
      const conversation = await createConversationRequest(trimmedTitle, { onNewConversation, projectId, agentId });
      if (conversation) {
        const normalized = typeof conversation === "string" ? { id: conversation, title: trimmedTitle } : { title: trimmedTitle, ...conversation };
        if (!normalized.id && !normalized.conversation_id) normalized.id = `conv-${Date.now()}`;
        upsertConversation(normalized);
        onSelectConversation?.(normalized);
      } else {
        const fallback = { id: `conv-${Date.now()}`, title: trimmedTitle };
        upsertConversation(fallback);
        onSelectConversation?.(fallback);
      }
      setModalOpen(false);
      setTitle("");
      setOpen(true);
    } catch (requestError) {
      setError(requestError?.message ?? "Unable to create conversation.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="conversations-accordion" data-open={open ? "true" : "false"}>
      <div className="conversations-accordion-header">
        <button
          type="button"
          className="conversations-accordion-toggle"
          aria-expanded={open}
          aria-controls="conversations-accordion-panel"
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={`conversations-accordion-arrow ${open ? "is-open" : ""}`}
            aria-hidden="true"
          >
            ▸
          </span>
          <span className="conversations-accordion-title">Conversations</span>
        </button>
        <button
          type="button"
          className="conversations-accordion-new" aria-label="New conversation"
          onClick={() => { setError(""); setModalOpen(true); }}
        >
          New Conversation
        </button>
        <CreateConversationModal
          open={modalOpen}
          title={title}
          error={error}
          creating={creating}
          onTitleChange={(next) => { setTitle(next); if (error) setError(""); }}
          onSubmit={handleCreateConversation}
          onClose={() => setModalOpen(false)}
        />
        {!modalOpen && error ? <p role="alert" className="conversations-accordion-error">{error}</p> : null}
      </div>
      {open && (
        <div
          id="conversations-accordion-panel"
          className={`conversations-accordion-panel ${open ? "is-open" : ""}`}
          role="region"
          aria-label="Conversations list"
        >
          <div className="conversations-accordion-panel-inner">

            {loading ? (
              <p className="conversations-accordion-loading">Loading conversations...</p>
            ) : fetchError ? (
              <p role="alert" className="conversations-accordion-error">Unable to load conversations.</p>
            ) : items.length === 0 ? (
              <p className="conversations-accordion-empty">No conversations yet.</p>
            ) : (
              <ul className="conversations-accordion-list">
                {items.map((conv) => {
                  const cid = getConversationId(conv);
                  const isEditing = editingId === cid;
                  const isArchived = conv.archived === true || conv.status === "archived";
                  const titleText = conv.title ?? conv.name ?? conv.id ?? conv.conversation_id;
                  // Drag handlers for reordering
                  const onDragStart = (e) => { setDragId(cid); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", cid); };
                  const onDragOver = (e) => { e.preventDefault(); if (dragId && dragId !== cid) setDragOverId(cid); };
                  const onDrop = (e) => {
                    e.preventDefault();
                    const targetId = cid;
                    const sourceId = dragId ?? e.dataTransfer.getData("text/plain");
                    if (!sourceId || sourceId === targetId) { setDragId(null); setDragOverId(null); return; }
                    setItems((prev) => {
                      const fromIdx = prev.findIndex((c) => getConversationId(c) === sourceId);
                      const toIdx = prev.findIndex((c) => getConversationId(c) === targetId);
                      if (fromIdx < 0 || toIdx < 0) return prev;
                      const next = [...prev];
                      const [moved] = next.splice(fromIdx, 1);
                      next.splice(toIdx, 0, moved);
                      persistOrder(next);
                      return next;
                    });
                    setDragId(null); setDragOverId(null);
                  };
                  // Delete with confirmation
                  const onDelete = () => {
                    if (typeof window !== "undefined" && !window.confirm("Delete this conversation?")) return;
                    setItems((prev) => { const next = prev.filter((c) => getConversationId(c) !== cid); persistOrder(next); return next; });
                    setMenuOpenId(null);
                  };
                  const onArchive = () => { setItems((prev) => prev.map((c) => getConversationId(c) === cid ? { ...c, archived: true, status: "archived" } : c)); setMenuOpenId(null); };
                  const onStartRename = () => { setEditingId(cid); setEditTitle(String(titleText)); setMenuOpenId(null); };
                  const onConfirmRename = () => {
                    const t = editTitle.trim();
                    if (!t || t.length > 120) return;
                    setItems((prev) => prev.map((c) => getConversationId(c) === cid ? { ...c, title: t, name: t } : c));
                    setEditingId(null); setEditTitle("");
                  };
                  return (
                    <ConversationsBlock
                      key={cid}
                      conversation={conv}
                      active={activeConversationId != null && String(activeConversationId) === String(cid)}
                      checked={selectedIds.has(cid)}
                      onCheckedChange={() => { setSelectedIds((prev) => { const n = new Set(prev); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; }); }}
                      onSelect={onSelectConversation}
                      menuOpen={menuOpenId === cid}
                      onMenuToggle={(next) => setMenuOpenId(next ? cid : null)}
                      isEditing={isEditing}
                      editTitle={editTitle}
                      onEditTitleChange={setEditTitle}
                      onStartRename={onStartRename}
                      onConfirmRename={onConfirmRename}
                      onCancelRename={() => { setEditingId(null); setEditTitle(""); }}
                      onDeleted={onDelete}
                      onArchived={onArchive}
                      onRenamed={onConfirmRename}
                      onDragStart={onDragStart}
                      onDragOver={onDragOver}
                      onDragLeave={() => setDragOverId(null)}
                      onDrop={onDrop}
                      onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                      isDragging={dragId === cid}
                      isDragOver={dragOverId === cid}
                      isArchived={isArchived}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
