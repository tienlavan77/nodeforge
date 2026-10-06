// Provides copy, edit, and per-message retry controls for owner messages in a conversation transcript.

"use client";

import { useState } from "react";

// Copies message text through the modern clipboard API or the browser fallback.
async function copyMessageText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("The browser could not copy the message.");
  } finally {
    textarea.remove();
  }
}

// Renders owner-message actions while keeping copy feedback local to the clicked message.
export function ConversationMessageActions({ message, onEdit, onRetry, children }) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(String(message?.text ?? ""));
  const text = String(message?.text ?? "");

  // Copies the complete owner message and gives brief visual confirmation.
  async function handleCopy() {
    try {
      await copyMessageText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error("Unable to copy owner message", error);
    }
  }

  // Saves an inline correction while keeping the draft open if persistence fails.
  async function handleSave() {
    setSaving(true);
    try {
      await onEdit(message, draft);
      setEditing(false);
    } catch (error) {
      console.error("Unable to save edited owner message", error);
    } finally {
      setSaving(false);
    }
  }

  return <>
    {editing ? <div className="claude-message-inline-edit">
      <textarea aria-label="Edit message" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={saving} />
      <button type="button" aria-label="Save edited message" title="Save" onClick={() => void handleSave()} disabled={!draft.trim() || saving}>✓</button>
      <button type="button" aria-label="Cancel edit" title="Cancel" onClick={() => { setDraft(text); setEditing(false); }} disabled={saving}>×</button>
    </div> : children}
    <div className="claude-message-actions" aria-label="Message actions">
      <button type="button" onClick={() => void handleCopy()} disabled={!text} aria-label={copied ? "Copied message" : "Copy message"} title={copied ? "Copied" : "Copy"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" /></svg>
      </button>
      <button type="button" onClick={() => { setDraft(text); setEditing((value) => !value); }} disabled={!text || saving} aria-label="Edit message" title="Edit">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.2-.9L20 7.3 16.7 4 4.9 15.8 4 20Z" /></svg>
      </button>
      <button type="button" onClick={() => void onRetry(message)} disabled={!text || editing} aria-label="Retry message" title="Retry">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5m11-1a8 8 0 0 0-14-5L4 8m16 8-2 2a8 8 0 0 1-14-5" /></svg>
      </button>
    </div>
  </>;
}
