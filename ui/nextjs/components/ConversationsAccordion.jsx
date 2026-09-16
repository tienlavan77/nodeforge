"use client";

import { useState } from "react";

export function ConversationsAccordion({
  conversations = [],
  onNewConversation,
  onSelectConversation,
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen);

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
          onClick={() => onNewConversation?.()}
        >
          New Conversation
        </button>
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
