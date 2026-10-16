"use client";
// Keeps the project chat draft responsive and lets message actions load text for editing.

import { createElement, useEffect, useRef, useState } from "react";
import { appendConversationComposerHistory, conversationComposerHistoryKey, readConversationComposerHistory, saveConversationComposerHistory } from "../lib/conversation-composer-history.js";

// Resets input recall and drafts when switching agents so one agent never receives another agent's recalled message.
export function HomeChatComposer({ projectId, agentId, onSend, editRequest }) {
  const historyKey = conversationComposerHistoryKey(projectId, agentId);
  return createElement(ScopedHomeChatComposer, { key: historyKey ?? "unbound", historyKey, onSend, editRequest });
}

// Owns the draft locally and sends it through the existing conversation handler.
function ScopedHomeChatComposer({ historyKey, onSend, editRequest }) {
  const [draft, setDraft] = useState("");
  const [markdownReply, setMarkdownReply] = useState(false);
  const [history, setHistory] = useState(() => readConversationComposerHistory(historyKey));
  const [historyIndex, setHistoryIndex] = useState(-1);
  const composingRef = useRef(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (!editRequest || typeof editRequest.text !== "string") return;
    setDraft(editRequest.text);
    setHistoryIndex(-1);
    textareaRef.current?.focus();
  }, [editRequest]);

  // Stores a sent message for quick retrieval without allowing unbounded browser storage growth.
  function remember(text) {
    const next = appendConversationComposerHistory(history, text);
    setHistory(next);
    saveConversationComposerHistory(historyKey, next);
  }

  // Submits the current draft and clears only the text accepted for sending.
  function submit(event) {
    event.preventDefault();
    if (composingRef.current) return;
    const text = textareaRef.current?.value.trim() ?? draft.trim();
    if (!text) return;
    remember(text);
    setHistoryIndex(-1);
    const responseContentType = markdownReply ? "text/markdown" : "text/plain";
    // Clear synchronously so the last typed character cannot remain visible while Node handles the request.
    setDraft("");
    void onSend(text, responseContentType);
  }

  // Navigates remembered messages only when the cursor is at a textarea edge.
  function navigateHistory(event) {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (!history.length || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const target = event.currentTarget;
    const atStart = target.selectionStart === 0;
    const atEnd = target.selectionEnd === target.value.length;
    if ((event.key === "ArrowUp" && !atStart) || (event.key === "ArrowDown" && !atEnd)) return;
    event.preventDefault();
    if (event.key === "ArrowUp") {
      const nextIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setDraft(history[nextIndex]);
    } else if (historyIndex >= 0) {
      const nextIndex = historyIndex + 1;
      setHistoryIndex(nextIndex >= history.length ? -1 : nextIndex);
      setDraft(nextIndex >= history.length ? "" : history[nextIndex]);
    }
  }

  return <form className="home-composer" onSubmit={submit}>
    <div className="home-composer-fields">
    <textarea ref={textareaRef} value={draft} onChange={(event) => { setDraft(event.target.value); setHistoryIndex(-1); }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={(event) => { composingRef.current = false; setDraft(event.currentTarget.value); }} onKeyDown={(event) => {
      navigateHistory(event);
      if (event.key === "Enter" && !event.shiftKey) {
        if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (event.currentTarget.value.trim()) event.currentTarget.form?.requestSubmit();
      }
    }} placeholder="Chat or paste a ticket..." rows="3" aria-label="Chat or ticket input" />
    <label className="home-composer-markdown"><input type="checkbox" checked={markdownReply} onChange={(event) => setMarkdownReply(event.target.checked)} />Markdown reply</label>
    </div>
    <button type="submit" aria-label="Send message" disabled={!draft.trim()}>&#8593;</button>
  </form>;
}
