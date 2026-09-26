"use client";
// Keeps the project chat draft responsive without rerendering the full workspace on every keystroke.

import { useEffect, useState } from "react";

const HISTORY_KEY = "nodeforge:project-chat-history";
const MAX_HISTORY = 50;

// Owns the draft locally and sends it through the existing conversation handler.
export function HomeChatComposer({ onSend }) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]");
      if (Array.isArray(stored)) setHistory(stored.filter((item) => typeof item === "string").slice(-MAX_HISTORY));
    } catch (error) {
      console.warn("Unable to restore project chat history", error);
    }
  }, []);

  // Stores a sent message for quick retrieval without allowing unbounded browser storage growth.
  function remember(text) {
    setHistory((current) => {
      const next = current[current.length - 1] === text ? current : [...current, text].slice(-MAX_HISTORY);
      try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); }
      catch (error) { console.warn("Unable to save project chat history", error); }
      return next;
    });
  }

  // Submits the current draft and clears only the text accepted for sending.
  function submit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    remember(text);
    setHistoryIndex(-1);
    // Clear synchronously so the last typed character cannot remain visible while Node handles the request.
    setDraft("");
    void onSend(text);
  }

  // Navigates remembered messages only when the cursor is at a textarea edge.
  function navigateHistory(event) {
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
    <textarea value={draft} onChange={(event) => { setDraft(event.target.value); setHistoryIndex(-1); }} onKeyDown={(event) => {
      navigateHistory(event);
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (draft.trim()) event.currentTarget.form?.requestSubmit();
      }
    }} placeholder="Chat or paste a ticket..." rows="2" aria-label="Chat or ticket input" />
    <button type="submit" aria-label="Send message" disabled={!draft.trim()}>&#8593;</button>
  </form>;
}
