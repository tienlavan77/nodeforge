// Loads earlier owner conversation messages while preserving the reader's scroll position.
import { useLayoutEffect, useRef, useState } from "react";
import { mergeConversationRevisions } from "./conversation-message-revisions.js";

const PAGE_SIZE = 50;

// Keeps paginated history and live messages in the same conversation view.
export function useConversationMessageHistory({ client, projectId, chatMessagesRef, agentDirectoryRef, agentDisplayName }) {
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const conversationRef = useRef(null);
  const loadRevisionRef = useRef(0);
  const cursorRef = useRef(null);
  const loadingRef = useRef(null);
  const restoreRef = useRef(null);
  const followLatestRef = useRef(true);

  useLayoutEffect(() => {
    const container = chatMessagesRef.current;
    if (!container) return;
    const restore = restoreRef.current;
    if (restore && restore.conversationId === conversationRef.current) {
      container.scrollTop = restore.top + container.scrollHeight - restore.height;
      restoreRef.current = null;
      return;
    }
    if (followLatestRef.current) container.scrollTop = container.scrollHeight;
  }, [messages, chatMessagesRef]);

  // Loads the newest page and resets the cursor when the owner changes conversations.
  async function loadConversationMessages(conversationId) {
    if (!conversationId) return;
    conversationRef.current = conversationId;
    const revision = ++loadRevisionRef.current;
    loadingRef.current = null;
    cursorRef.current = null;
    restoreRef.current = null;
    followLatestRef.current = true;
    setMessages([]);
    setHasOlder(false);
    setOlderLoading(false);
    setHistoryError("");
    setMessagesLoading(true);
    try {
      const result = await client.getConversationMessages({ projectId, conversationId, limit: PAGE_SIZE, order: "desc" });
      if (conversationRef.current !== conversationId || loadRevisionRef.current !== revision) return;
      const items = Array.isArray(result) ? result : result?.items ?? [];
      cursorRef.current = result?.next_cursor ?? null;
      setHasOlder(Boolean(cursorRef.current));
      setMessages((current) => {
        const history = mergeConversationRevisions(items.slice().reverse().map(toMessage));
        const existing = new Set(history.map((message) => message.stream_key));
        return mergeConversationRevisions([...history, ...current.filter((message) => message.pending || !existing.has(message.stream_key))]);
      });
    } catch (error) {
      if (conversationRef.current === conversationId && loadRevisionRef.current === revision) { setMessages([]); setHistoryError(error.message); }
    } finally {
      if (conversationRef.current === conversationId && loadRevisionRef.current === revision) setMessagesLoading(false);
    }
  }

  // Prefetches the next page before the reader reaches the second oldest message.
  async function loadEarlierMessages() {
    const conversationId = conversationRef.current;
    const revision = loadRevisionRef.current;
    const cursor = cursorRef.current;
    const container = chatMessagesRef.current;
    if (!conversationId || !cursor || !container || loadingRef.current === revision || messagesLoading) return;
    loadingRef.current = revision;
    setOlderLoading(true);
    setHistoryError("");
    const anchor = { conversationId, height: container.scrollHeight, top: container.scrollTop };
    try {
      const result = await client.getConversationMessages({ projectId, conversationId, limit: PAGE_SIZE, cursor, order: "desc" });
      if (conversationRef.current !== conversationId || loadRevisionRef.current !== revision) return;
      const items = Array.isArray(result) ? result : result?.items ?? [];
      cursorRef.current = result?.next_cursor ?? null;
      setHasOlder(Boolean(cursorRef.current));
      if (items.length) {
        restoreRef.current = anchor;
        setMessages((current) => {
          return mergeConversationRevisions([...items.slice().reverse().map(toMessage), ...current]);
        });
      }
    } catch (error) {
      if (conversationRef.current === conversationId && loadRevisionRef.current === revision) setHistoryError(error.message);
    } finally {
      if (loadingRef.current === revision) loadingRef.current = null;
      if (conversationRef.current === conversationId && loadRevisionRef.current === revision) setOlderLoading(false);
    }
  }

  // Tracks whether incoming agent text should keep the view at the latest message.
  function handleMessageScroll() {
    const container = chatMessagesRef.current;
    if (!container) return;
    followLatestRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 72;
    const firstMessages = [...container.querySelectorAll(".home-chat-message")].slice(0, 2);
    const preloadThreshold = Math.max(120, firstMessages.reduce((total, item) => total + item.getBoundingClientRect().height, 0) + 24);
    if (container.scrollTop <= preloadThreshold) void loadEarlierMessages();
  }

  // Follows a newly submitted message without changing history pagination.
  function followLatest() {
    followLatestRef.current = true;
    const container = chatMessagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }

  // Converts one persisted record to the display shape used by live events.
  function toMessage(record) {
    const content = record.content ?? {};
    const text = typeof content === "string" ? content : content.text ?? content.content ?? "";
    const isOwner = record.kind === "owner";
    const originalId = isOwner && typeof content.supersedes_message_id === "string" ? content.supersedes_message_id : record.id;
    return { id: originalId, source_message_id: record.id, stream_key: `${isOwner ? "owner" : "agent"}:${originalId}`,
      text: String(text ?? ""), from: isOwner ? "owner" : record.kind === "failure" ? "system" : "agent",
      nickname: isOwner ? "You" : agentDisplayName(record.agent_id, agentDirectoryRef.current),
      timestamp: record.timestamp ?? new Date().toISOString() };
  }

  return { messages, setMessages, messagesLoading, setMessagesLoading, olderLoading, hasOlder, historyError,
    loadConversationMessages, loadEarlierMessages, handleMessageScroll, followLatest };
}
