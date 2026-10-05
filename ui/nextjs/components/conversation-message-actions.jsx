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
export function ConversationMessageActions({ message, onEdit, onRetry }) {
  const [copied, setCopied] = useState(false);
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

  return <div className="claude-message-actions" aria-label="Message actions">
    <button type="button" onClick={() => void handleCopy()} disabled={!text} aria-label="Copy message">
      {copied ? "Copied" : "Copy"}
    </button>
    <button type="button" onClick={() => onEdit(text)} disabled={!text} aria-label="Edit message">
      Edit
    </button>
    <button type="button" onClick={() => void onRetry(message)} disabled={!text} aria-label="Retry message">
      Retry
    </button>
  </div>;
}
