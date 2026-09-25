// Streams chat history into the UI: live push, token-by-token delta rendering, and scroll/pagination handling.

// Builds the live chat-history renderer for one NodeForge app render pass: token
// streaming, live message push, auto-scroll, and infinite-scroll pagination.
export function createHistoryStreamController({
  conversationRefs,
  wasAtBottomRef,
  streamQueues,
  streamingIdsRef,
  pendingLive,
  historyChat,
  setHistoryChat,
  historyLoadingRef,
  historyHasMoreRef,
  loadHistoryPage,
  toDisplayMessage,
  historyRecordToMessage,
  formatDateLabel
}) {
  function scrollToBottom(agentId) {
    const el = conversationRefs.current[agentId];
    if (el) el.scrollTop = el.scrollHeight;
  }

  function isAtBottom(agentId) {
    const el = conversationRefs.current[agentId];
    if (!el) return wasAtBottomRef.current[agentId] ?? true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  function pushLiveHistory(agentId, message) {
    const mapped = toDisplayMessage(message);
    if (!mapped?.text || mapped.message_type?.endsWith(".tool.result") || mapped.message_type?.endsWith(".message.progress") || mapped.message_type?.endsWith(".progress") || mapped.message_type?.endsWith(".working")) return;
    if (mapped.message_type?.endsWith(".message.delta")) return;
    const entry = historyRecordToMessage({ id: message.message_id, kind: mapped.from, type: message.message_type, content: { text: mapped.text }, timestamp: message.timestamp, correlation_id: message.correlation_id });
    if (!entry) return;
    if ((historyChat[agentId] ?? []).some((m) => m.id === entry.id)) return;
    pendingLive.current[agentId] = [...(pendingLive.current[agentId] ?? []), entry];
    setHistoryChat((m) => {
      const cur = m[agentId] ?? [];
      if (cur.some((x) => x.id === entry.id || (x.correlation_id && x.correlation_id === entry.correlation_id && x.text === entry.text))) return m;
      const streamingIdx = cur.findIndex((x) => x.correlation_id === entry.correlation_id && x.stream === true);
      if (streamingIdx >= 0) {
        const next = [...cur];
        next[streamingIdx] = { ...entry, stream: false };
        return { ...m, [agentId]: next };
      }
      return { ...m, [agentId]: [...cur, entry] };
    });
  }

  function queueHistoryDelta(agentId, message) {
    const text = String(message.payload?.text ?? "");
    if (!text) return;
    const tokens = text.match(/\S+|\s+/g) ?? [text];
    const queue = streamQueues.current[agentId] ?? (streamQueues.current[agentId] = []);
    const baseId = message.message_id;
    const correlationId = message.correlation_id;
    const timestamp = message.timestamp;
    const tsDate = timestamp ? new Date(timestamp) : new Date();
    const now = Date.now();
    tokens.forEach((token, i) => {
      queue.push({ token, correlationId, timestamp, messageId: `${baseId}:tok:${now}:${i}:${Math.random().toString(36).slice(2, 6)}` });
    });
    if (queue.timer) return;
    const tick = () => {
      const next = queue.shift();
      if (!next) { queue.timer = undefined; return; }
      const atBottom = isAtBottom(agentId) || wasAtBottomRef.current[agentId];
      setHistoryChat((prev) => {
        const chat = prev[agentId] ?? [];
        let idx = chat.findIndex((m) => m.correlation_id === next.correlationId && m.stream === true);
        if (idx < 0) {
          const recentStream = chat.length && chat[chat.length - 1]?.stream === true && chat[chat.length - 1]?.correlation_id === next.correlationId;
          if (!recentStream) {
            const d = next.timestamp ? new Date(next.timestamp) : tsDate;
            const entry = { id: next.messageId, correlation_id: next.correlationId, message_type: "agent.message.delta", from: "agent", text: next.token, time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: next.timestamp, dateKey: Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10), dateLabel: next.timestamp ? formatDateLabel(next.timestamp) : formatDateLabel(tsDate.toISOString()), stream: true };
            streamingIdsRef.current[agentId] = entry.correlation_id;
            return { ...prev, [agentId]: [...chat, entry] };
          }
          idx = chat.length - 1;
        }
        const nextChat = [...chat];
        const cur = nextChat[idx];
        nextChat[idx] = { ...cur, text: cur.text + next.token, id: next.messageId, time: cur.time };
        return { ...prev, [agentId]: nextChat };
      });
      if (atBottom) requestAnimationFrame(() => scrollToBottom(agentId));
      queue.timer = setTimeout(tick, 18);
    };
    tick();
  }

  function finalizeHistoryDelta(agentId, message) {
    const queue = streamQueues.current[agentId];
    if (queue?.timer) { clearTimeout(queue.timer); queue.timer = undefined; queue.length = 0; }
    const text = String(message.payload?.text ?? "");
    const corr = message.correlation_id;
    const ts = message.timestamp;
    const d = ts ? new Date(ts) : new Date();
    setHistoryChat((prev) => {
      const chat = prev[agentId] ?? [];
      const idx = chat.findIndex((m) => m.correlation_id === corr && m.stream === true);
      if (idx >= 0) {
        const next = [...chat];
        next[idx] = { ...next[idx], text: text || next[idx].text, id: message.message_id, stream: false, message_type: message.message_type, time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: ts, dateKey: Number.isNaN(d.getTime()) ? next[idx].dateKey : d.toISOString().slice(0, 10), dateLabel: ts ? formatDateLabel(ts) : next[idx].dateLabel };
        return { ...prev, [agentId]: next };
      }
      if (text && !chat.some((m) => m.id === message.message_id)) {
        const entry = historyRecordToMessage({ id: message.message_id, kind: "agent", type: message.message_type, content: { text }, timestamp: ts, correlation_id: corr });
        if (entry) return { ...prev, [agentId]: [...chat, entry] };
      }
      return prev;
    });
    requestAnimationFrame(() => { if (isAtBottom(agentId)) scrollToBottom(agentId); });
  }

  function handleScroll(agentId) {
    const el = conversationRefs.current[agentId];
    if (!el || historyLoadingRef.current[agentId] || !historyHasMoreRef.current[agentId]) return;
    if (el.scrollTop > 24) return;
    el.dataset.loadingOlder = "1";
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    loadHistoryPage(agentId, "older").then(() => {
      requestAnimationFrame(() => {
        const cur = conversationRefs.current[agentId];
        if (!cur) return;
        cur.scrollTop = cur.scrollHeight - prevHeight + prevTop;
        requestAnimationFrame(() => { delete cur.dataset.loadingOlder; });
      });
    });
  }

  return { pushLiveHistory, isAtBottom, queueHistoryDelta, finalizeHistoryDelta, scrollToBottom, handleScroll };
}
