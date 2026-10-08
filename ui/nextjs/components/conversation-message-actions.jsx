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
      <button type="button" className={copied ? "is-copied" : ""} onClick={() => void handleCopy()} disabled={!text} aria-label={copied ? "Copied message" : "Copy message"} title={copied ? "Copied" : "Copy"}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{copied ? <path d="m5 12 4 4L19 6" /> : <path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />}</svg>
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

// Renders copy and share actions for agent responses without exposing owner-only mutations.
export function ConversationAgentMessageActions({ message, children, client, projectId }) {
  const [copied, setCopied] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const text = String(message?.text ?? "");
  const isMarkdown = message?.content_type === "text/markdown";

  // Copies an agent response and keeps feedback local to the selected transcript item.
  async function handleCopy() {
    try {
      await copyMessageText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error("Unable to copy agent message", error);
    }
  }

  // Uses native sharing when available and otherwise provides shareable copied text.
  async function handleShare() {
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
      await copyMessageText(text);
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error("Unable to share agent message", error);
    }
  }

  // Downloads the original UTF-8 response bytes without converting rendered Markdown.
  function handleDownload() {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agent-response-${String(message?.id ?? "message").replace(/[^A-Za-z0-9._-]/g, "-")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // Saves Markdown through the project-scoped API and asks before replacing an existing export.
  async function handleSaveFile(confirmOverwrite = false) {
    if (!client?.saveConversationMarkdown || !projectId || !message?.conversation_id || !message?.id) return;
    setExporting(true);
    setExportStatus("");
    try {
      let result;
      try {
        result = await client.saveConversationMarkdown({ projectId, conversationId: message.conversation_id, messageId: message.id, confirmOverwrite });
      } catch (error) {
        if (error?.status !== 409 || error?.code !== "MARKDOWN_EXPORT_EXISTS" || confirmOverwrite || !window.confirm("This Markdown file already exists. Replace it?")) throw error;
        result = await client.saveConversationMarkdown({ projectId, conversationId: message.conversation_id, messageId: message.id, confirmOverwrite: true });
      }
      setExportStatus(`Saved ${result.path}`);
    } catch (error) {
      setExportStatus(error?.message ?? "Could not save Markdown.");
    } finally {
      setExporting(false);
    }
  }

  return <>
    {isMarkdown && <span className="conversation-markdown-badge">Markdown</span>}
    {children}
    <div className="claude-message-actions" aria-label="Agent message actions">
      <button type="button" className={copied ? "is-copied" : ""} onClick={() => void handleCopy()} disabled={!text} aria-label={copied ? "Copied agent message" : "Copy agent message"} title={copied ? "Copied" : "Copy"}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{copied ? <path d="m5 12 4 4L19 6" /> : <path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />}</svg>
      </button>
      <button type="button" onClick={() => void handleShare()} disabled={!text} aria-label="Share agent message" title="Share">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L8 8m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
      </button>
      {isMarkdown && <>
        <button type="button" onClick={handleDownload} disabled={!text} aria-label="Download Markdown" title="Download .md">↓</button>
        <button type="button" onClick={() => void handleSaveFile()} disabled={exporting || !text || !client} aria-label="Save Markdown to project" title="Write file">{exporting ? "…" : "↳"}</button>
      </>}
    </div>
    {exportStatus && <p className="conversation-markdown-export-status" role="status">{exportStatus}</p>}
  </>;
}
