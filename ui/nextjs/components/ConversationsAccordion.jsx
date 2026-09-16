"use client";

import { useState } from "react";
import { CreateConversationModal } from "./CreateConversationModal.jsx";

async function createConversationRequest(title, { onNewConversation, projectId, agentId } = {}) {
  if (onNewConversation) return onNewConversation(title);
  const body = { title };
  if (projectId) body.project_id = projectId;
  if (agentId) body.agent_id = agentId;
  const response = await fetch("/forge/v1/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? "Unable to create conversation.");
  return payload.conversation ?? payload;
}

export function ConversationsAccordion({
  conversations = [],
  onNewConversation,
  onSelectConversation,
  defaultOpen = false,
  projectId,
  agentId,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

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
      setModalOpen(false);
      setTitle("");
      if (conversation) onSelectConversation?.(conversation);
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

            {conversations.length === 0 ? (
              <p className="conversations-accordion-empty">No conversations yet.</p>
            ) : (
              <ul className="conversations-accordion-list">
                {conversations.map((conv) => (
                  <li key={conv.id ?? conv.conversation_id ?? conv.conversationId}>
                    <button
                      type="button"
                      className="conversations-accordion-item"
                      onClick={() => onSelectConversation?.(conv)}
                    >
                      <span className="conversations-accordion-item-title">
                        {conv.title ?? conv.name ?? conv.id ?? conv.conversation_id}
                      </span>
                      {conv.updated_at || conv.updatedAt ? (
                        <time className="conversations-accordion-item-time">
                          {conv.updated_at ?? conv.updatedAt}
                        </time>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
