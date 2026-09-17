// Modal for creating a new conversation via portal overlay.
"use client";

import { createPortal } from "react-dom";

// Renders the create-conversation modal with title input and validation feedback.
export function CreateConversationModal({ open, title, error, creating, onTitleChange, onSubmit, onClose }) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="conversations-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="conversations-modal" role="dialog" aria-modal="true" aria-labelledby="conversation-modal-title">
        <h2 id="conversation-modal-title">New Conversation</h2>
        <form onSubmit={onSubmit}>
          <label htmlFor="conversation-title">Conversation title</label>
          <input
            id="conversation-title"
            name="title"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            autoFocus
            required
            maxLength={120}
            aria-invalid={Boolean(error)}
            placeholder="Enter conversation title"
          />
          {error ? (
            <p role="alert" className="conversations-accordion-error">
              {error}
            </p>
          ) : null}
          <div className="conversations-modal-actions">
            <button type="button" onClick={onClose} disabled={creating}>
              Cancel
            </button>
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
