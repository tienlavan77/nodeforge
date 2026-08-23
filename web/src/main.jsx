import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createNodeClient } from "./services/node-client.js";
import { validateSprintPlan } from "./services/sprint-plan-validator.js";
import "./styles.css";

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet" },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan" },
  { id: "builder", label: "Builder", short: "BU", tone: "amber" },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green" }
];
const PROJECT_ID = "PROJECT-NODEFORGE";
const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";
const CONVERSATIONS = {
  "architecture-manager": "CONV-ARCHITECTURE",
  "sprint-leader": "CONV-SPRINT-LEADER",
  "builder": "CONV-BUILDER",
  "reviewer": "CONV-REVIEWER"
};
const CHAT_PAGE_SIZE = 10;
const PROVIDER_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom / OpenAI-compatible" }
];

function formatDateLabel(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function historyRecordToMessage(record) {
  if (record.type?.endsWith(".tool.result") || record.type?.endsWith(".message.progress") || record.type?.endsWith(".progress") || record.type?.endsWith(".working")) return null;
  const isOwner = record.kind === "owner";
  const raw = record.content;
  const text = raw?.text ?? raw?.content ?? (typeof raw === "string" ? raw : JSON.stringify(raw ?? ""));
  const from = isOwner ? "owner" : record.kind === "failure" ? "system" : record.kind === "agent" || record.kind === "completion" ? "agent" : isOwner ? "owner" : "agent";
  const ts = record.timestamp;
  const d = ts ? new Date(ts) : new Date();
  return { id: record.id, correlation_id: record.correlation_id, message_type: record.type, from, text: String(text ?? record.type), time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: ts, dateKey: Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10), dateLabel: ts ? formatDateLabel(ts) : "" };
}
const MODEL_CATALOG = {
  codex: [
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol (default)" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.2", label: "GPT-5.2" }
  ],
  openai: [
    { value: "gpt-5.6", label: "GPT-5.6" },
    { value: "gpt-5.6-mini", label: "GPT-5.6 Mini" },
    { value: "gpt-5.1", label: "GPT-5.1" }
  ],
  anthropic: [
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" }
  ],
  claude: [
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-opus-5", label: "Claude Opus 5" },
    { value: "claude-opus-4-8[1m]", label: "Claude Opus 4.8 [1m]" },
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "claude-sonnet-4-0", label: "Claude Sonnet 4.0" },
    { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
    { value: "claude-haiku-4-3", label: "Claude Haiku 4.3" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (2024-10-22)" }
  ]
};

function App() {
  const client = useMemo(() => createNodeClient(), []);
  const [activeAgent, setActiveAgent] = useState("architecture-manager");
  const [drafts, setDrafts] = useState({});
  const [workspace, setWorkspace] = useState(null);
  const [workingByAgent, setWorkingByAgent] = useState(() => Object.fromEntries(AGENTS.map((agent) => [agent.id, "READY"])));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [historyChat, setHistoryChat] = useState(() => Object.fromEntries(AGENTS.map((a) => [a.id, []])));
  const [historyCursor, setHistoryCursor] = useState(() => Object.fromEntries(AGENTS.map((a) => [a.id, null])));
  const [historyHasMore, setHistoryHasMore] = useState(() => Object.fromEntries(AGENTS.map((a) => [a.id, true])));
  const [historyLoading, setHistoryLoading] = useState(() => Object.fromEntries(AGENTS.map((a) => [a.id, false])));
  const historyCursorRef = useRef(Object.fromEntries(AGENTS.map((a) => [a.id, null])));
  const historyHasMoreRef = useRef(Object.fromEntries(AGENTS.map((a) => [a.id, true])));
  const historyLoadingRef = useRef(Object.fromEntries(AGENTS.map((a) => [a.id, false])));
  const pendingLive = useRef(Object.fromEntries(AGENTS.map((a) => [a.id, []])));
  const lastMessageId = useRef({});
  const conversationRefs = useRef({});
  const composerRef = useRef(null);
  const streamQueues = useRef({});
  const wasAtBottomRef = useRef(Object.fromEntries(AGENTS.map((a) => [a.id, true])));
  const streamingIdsRef = useRef(Object.fromEntries(AGENTS.map((a) => [a.id, null])));
  const dispatchTimersRef = useRef({});
  const pendingDispatchRef = useRef({});
  const active = AGENTS.find((agent) => agent.id === activeAgent);
  const loadWorkspace = useCallback(async () => {
    try {
      const data = await client.getArchitectureWorkspace(PROJECT_ID);
      setWorkspace(data);
      // A persisted WORKING flag can be stale after a Node restart. Live SSE
      // events are the authority for an active run, so do not restore it here.
      if (data?.agent?.status && data.agent.status !== "WORKING") {
        setWorkingByAgent((prev) => ({ ...prev, "architecture-manager": data.agent.status }));
      }
    } catch {
      setWorkingByAgent((prev) => ({ ...prev, "architecture-manager": "FAILED" }));
    }
  }, [client]);
  const loadDashboard = useCallback(async () => {
    try {
      const primary = await client.getProjectDashboard(PROJECT_ID);
      if (primary?.roadmap || PROJECT_ID === "PROJECT-114A") { setDashboard(primary); return; }
      setDashboard(await client.getProjectDashboard("PROJECT-114A"));
    } catch {
      try { setDashboard(await client.getProjectDashboard("PROJECT-114A")); } catch { setDashboard(null); }
    }
  }, [client]);

  const loadHistoryPage = useCallback(async (agentId, direction = "initial") => {
    if (historyLoadingRef.current[agentId]) return;
    if (direction === "older" && !historyHasMoreRef.current[agentId]) return;
    historyLoadingRef.current[agentId] = true;
    setHistoryLoading((m) => ({ ...m, [agentId]: true }));
    try {
      const cursor = direction === "older" ? historyCursorRef.current[agentId] : null;
      const conversationId = CONVERSATIONS[agentId];
      const result = await client.getConversationAuditHistory({ projectId: PROJECT_ID, agentId, conversationId, limit: CHAT_PAGE_SIZE, order: "desc", cursor: cursor ?? undefined });
      const page = result.items.map(historyRecordToMessage).filter(Boolean).reverse();
      const nextCursor = result.next_cursor;
      const hasMore = Boolean(nextCursor);
      historyCursorRef.current[agentId] = nextCursor;
      historyHasMoreRef.current[agentId] = hasMore;
      setHistoryChat((m) => {
        const existing = m[agentId] ?? [];
        if (direction === "older") {
          const ids = new Set(existing.map((x) => x.id));
          const fresh = page.filter((x) => !ids.has(x.id));
          return { ...m, [agentId]: [...fresh, ...existing] };
        }
        const stash = pendingLive.current[agentId] ?? [];
        const merged = [...page];
        const ids = new Set(page.map((x) => x.id));
        for (const live of stash) if (!ids.has(live.id)) merged.push(live);
        // drop stale fallback seeds if history now has real data
        if (merged.length > CHAT_PAGE_SIZE && page.length > 0) {
          const realIds = new Set(page.map((x) => x.id));
          if (![...stash].some((s) => realIds.has(s.id))) {
            // keep only history + live that arrived after page
          }
        }
        return { ...m, [agentId]: merged };
      });
      setHistoryCursor((m) => ({ ...m, [agentId]: nextCursor }));
      setHistoryHasMore((m) => ({ ...m, [agentId]: hasMore }));
      if (direction === "initial" && page.length) {
        lastMessageId.current[agentId] = page[page.length - 1]?.id ?? lastMessageId.current[agentId];
      }
    } catch {
      // best-effort history; live SSE remains the source of truth for new messages
    } finally {
      historyLoadingRef.current[agentId] = false;
      setHistoryLoading((m) => ({ ...m, [agentId]: false }));
    }
  }, [client]);

  useEffect(() => { for (const a of AGENTS) loadHistoryPage(a.id, "initial"); }, [loadHistoryPage]);

  useEffect(() => {
    loadWorkspace();
    loadDashboard();
    const streams = AGENTS.map((agent) => {
      const conversationId = CONVERSATIONS[agent.id];
      return client.connectConversationStream({
        projectId: PROJECT_ID,
        conversationId,
        afterMessageId: lastMessageId.current[agent.id],
        onMessage: (message) => {
          lastMessageId.current[agent.id] = message.message_id;
          const pendingCorrelation = pendingDispatchRef.current[agent.id];
          const isRunningEvent = message.correlation_id === pendingCorrelation && (
            message.message_type === "architecture.working" || message.message_type === `${agent.id}.working`
            || message.message_type === "agent.text_stream" || message.message_type?.endsWith(".message.delta")
            || (message.message_type === "node.status_change" && message.payload?.to === "running")
          );
          if (isRunningEvent) {
            clearTimeout(dispatchTimersRef.current[agent.id]);
            delete dispatchTimersRef.current[agent.id];
            delete pendingDispatchRef.current[agent.id];
            setWorkingByAgent((prev) => ({ ...prev, [agent.id]: "WORKING" }));
          }
          if (message.message_type.endsWith(".message.received") || message.message_type.endsWith(".error")) setWorkingByAgent((prev) => ({ ...prev, [agent.id]: message.payload?.agent_status ?? (message.message_type.endsWith(".error") ? "FAILED" : "COMPLETED") }));
          if (message.message_type.endsWith(".message.delta")) {
            queueHistoryDelta(agent.id, message);
          } else if (message.message_type.endsWith(".message.received")) {
            finalizeHistoryDelta(agent.id, message);
            pushLiveHistory(agent.id, message);
          } else if (!message.message_type.endsWith(".tool.result") && !message.message_type.endsWith(".message.progress") && !message.message_type.endsWith(".progress") && !message.message_type.endsWith(".working")) {
            pushLiveHistory(agent.id, message);
          }
          if (message.message_type === "governance.sprint_plan.created") loadDashboard();
          if (message.message_type === "node.status_change" && message.payload?.ticket_id) loadDashboard();
          if (agent.id === "architecture-manager" && message.message_type === "architecture.message.received") loadWorkspace();
        },
        onReplayComplete: () => setWorkingByAgent((prev) => ({ ...prev, [agent.id]: prev[agent.id] === "WORKING" ? "READY" : prev[agent.id] })),
        onError: () => {
          if (pendingDispatchRef.current[agent.id]) {
            clearTimeout(dispatchTimersRef.current[agent.id]);
            delete dispatchTimersRef.current[agent.id];
            delete pendingDispatchRef.current[agent.id];
            setWorkingByAgent((prev) => ({ ...prev, [agent.id]: "FAILED" }));
          }
        }
      });
    });
    return () => streams.forEach((s) => s.close());
  }, [client, loadDashboard, loadWorkspace]);

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

  function isAtBottom(agentId) {
    const el = conversationRefs.current[agentId];
    if (!el) return wasAtBottomRef.current[agentId] ?? true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
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

  async function send(agentId) {
    const text = drafts[agentId]?.trim();
    if (!text) return;
    const conversationId = CONVERSATIONS[agentId] ?? ARCHITECTURE_CONVERSATION_ID;
    const messageId = `MSG-OWNER-${Date.now()}-${agentId}`;
    const nowIso = new Date().toISOString();
    const nowDate = new Date(nowIso);
    const optimistic = { id: messageId, correlation_id: `CORR-${agentId}-${Date.now()}`, message_type: "owner.message", from: "owner", text, time: nowDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: nowIso, dateKey: nowIso.slice(0, 10), dateLabel: formatDateLabel(nowIso) };
    setDrafts((current) => ({ ...current, [agentId]: "" }));
    pendingDispatchRef.current[agentId] = optimistic.correlation_id;
    setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), optimistic] }));
    pendingLive.current[agentId] = [...(pendingLive.current[agentId] ?? []), optimistic];
    requestAnimationFrame(() => scrollToBottom(agentId));
    try {
      await client.postOwnerMessage({
        projectId: PROJECT_ID,
        conversationId,
        agentId,
        messageId,
        correlationId: optimistic.correlation_id,
        text
      });
      dispatchTimersRef.current[agentId] = setTimeout(() => {
        if (pendingDispatchRef.current[agentId] !== optimistic.correlation_id) return;
        delete pendingDispatchRef.current[agentId];
        setWorkingByAgent((current) => ({ ...current, [agentId]: "FAILED" }));
        const errTs = new Date().toISOString();
        setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), { id: `ERR-${Date.now()}`, from: "system", text: "Builder did not start the ticket within the expected time.", time: new Date(errTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: errTs, dateKey: errTs.slice(0, 10), dateLabel: formatDateLabel(errTs), message_type: "system.timeout" }] }));
      }, 15000);
    } catch (error) {
      delete pendingDispatchRef.current[agentId];
      setWorkingByAgent((current) => ({ ...current, [agentId]: "FAILED" }));
      const errTs = new Date().toISOString();
      setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), { id: `ERR-${Date.now()}`, from: "system", text: error?.message ?? "Node request failed. Your message was not sent.", time: new Date(errTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: errTs, dateKey: errTs.slice(0, 10), dateLabel: formatDateLabel(errTs), message_type: "system.error" }] }));
    }
  }

  const activeAgentObj = AGENTS.find((a) => a.id === activeAgent);
  const isWorking = workingByAgent[activeAgent] === "WORKING";

  function scrollToBottom(agentId) {
    const el = conversationRefs.current[agentId];
    if (el) el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    requestAnimationFrame(() => scrollToBottom(activeAgent));
  }, [activeAgent]);

  useEffect(() => {
    const el = conversationRefs.current[activeAgent];
    if (el && !el.dataset.loadingOlder) scrollToBottom(activeAgent);
  }, [historyChat, activeAgent]);

  useEffect(() => {
    if (!isWorking) composerRef.current?.focus();
  }, [activeAgent, isWorking]);

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

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><div><div className="brand-name">NODE CONTROL ROOM</div><div className="brand-sub">Human governance surface</div></div></div>
      <div className="topbar-meta"><span className="connection"><span className="live-dot" /> NODE ONLINE</span><span className="divider" /><span className="project-label">PROJECT <strong>NODEFORGE</strong></span><button className="history-button" onClick={() => setUploadOpen(true)}>Upload Sprint Plan</button><button className="history-button" onClick={() => setHistoryOpen(true)}>History</button><button className="icon-button" title="Open settings" aria-label="Open settings">&#9881;</button></div>
    </header>
    <main className="workspace">
      <section className="chat-area panel" aria-label="Agent conversations">
        <div className="tab-bar" role="tablist" aria-label="Agent tabs">
          {AGENTS.map((agent) => (
            <button key={agent.id} role="tab" aria-selected={activeAgent === agent.id} className={`tab-button ${activeAgent === agent.id ? "is-active" : ""} ${workingByAgent[agent.id] === "WORKING" ? "is-working" : ""}`} onClick={() => setActiveAgent(agent.id)} aria-label={`${agent.label} tab`}>
              <span className={`agent-avatar small ${agent.tone}`}>{agent.short}</span>
              <span className="tab-label">{agent.label}</span>
              {workingByAgent[agent.id] === "WORKING" && <span className="working-dot" aria-label="working" />}
            </button>
          ))}
        </div>
        <div style={{ display: "contents" }}>
          {AGENTS.map((agent) => {
            const isActive = activeAgent === agent.id;
            const working = workingByAgent[agent.id] === "WORKING";
            const rawChat = historyChat[agent.id] ?? [];
            const groups = [];
            const groupsByKey = new Map();
            for (const msg of rawChat) {
              const key = msg.dateKey ?? "";
              const label = msg.dateLabel ?? formatDateLabel(msg.timestamp);
              let group = groupsByKey.get(key);
              if (!group) {
                group = { key, label, messages: [] };
                groupsByKey.set(key, group);
                groups.push(group);
              }
              group.messages.push(msg);
            }
            const hasMore = historyHasMore[agent.id];
            const loading = historyLoading[agent.id];
            return <div key={agent.id} className="active-chat-panel" style={{ display: isActive ? "flex" : "none" }}>
              <PanelHeader agent={{ ...agent, status: workingByAgent[agent.id] }} onSettings={() => setSettingsAgent(agent)} />
              <div className="conversation natural-conversation" ref={(el) => { if (el) conversationRefs.current[agent.id] = el; }} onScroll={(e) => { const el = e.currentTarget; wasAtBottomRef.current[agent.id] = el.scrollHeight - el.scrollTop - el.clientHeight < 72; if (el.scrollTop <= 20) handleScroll(agent.id); }} role="log" aria-label={`${agent.label} messages`}>
                {groups.length === 0 && <div className="date-rule"><span>Conversation</span></div>}
                {loading && !rawChat.length && <p className="dashboard-state">Loading conversation…</p>}
                {hasMore && rawChat.length > 0 && <button className="history-more chat-load-more" onClick={() => handleScroll(agent.id)} disabled={loading}>{loading ? "Loading…" : "Load earlier messages"}</button>}
                {!hasMore && rawChat.length > 0 && <p className="dashboard-state" style={{ textAlign: "center" }}>Beginning of conversation</p>}
                {groups.map((group) => <div key={group.key || group.label} className="chat-date-group" data-date={group.key}>
                  <div className="date-rule"><span>{group.label || "Conversation"}</span></div>
                  {group.messages.map((message, index) => <Message key={message.id ?? `${agent.id}-${group.key}-${index}`} message={message} />)}
                </div>)}
                {working && <div className="working-status" role="status">{agent.label} is working…</div>}
              </div>
              {agent.id === "architecture-manager" && isActive && <InlineDecisionControls client={client} onWorkspaceChanged={loadWorkspace} workspace={workspace} />}
              <form className="composer" onSubmit={(event) => { event.preventDefault(); send(agent.id); }}>
                <textarea ref={isActive ? composerRef : undefined} value={drafts[agent.id] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [agent.id]: event.target.value }))} onInput={(event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(agent.id); } }} rows="2" placeholder={`Message ${agent.label}...`} aria-label={`Message ${agent.label}`} disabled={working} />
                <button type="submit" title="Send message" aria-label="Send message" disabled={working}>&#8593;</button>
              </form>
            </div>;
          })}
        </div>
      </section>
      <section className="info-panel panel" aria-label="Project info">
        <div className="info-artifacts">
          {getPendingArchitectureProposal(workspace) && <ArchitectureArtifacts workspace={workspace} />}
          <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={loadDashboard} />
        </div>
      </section>
    </main>
    <footer className="statusbar"><div><span className="status-key">ACTIVE CHANNEL</span><span className="status-value">{active.label}</span></div><div className="event-status"><span className="pulse" /> Event stream ready <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
    {historyOpen && <HistoryOverlay client={client} onClose={() => setHistoryOpen(false)} />}
    {settingsAgent && <AgentSettingsOverlay client={client} agent={settingsAgent} onClose={() => setSettingsAgent(null)} />}
    {uploadOpen && <UploadSprintPlanDialog client={client} onClose={() => setUploadOpen(false)} onUploaded={loadDashboard} />}
  </div>;
}

function SprintPlanDashboard({ dashboard, client, onRefresh }) {
  const [runningId, setRunningId] = useState(null);
  const [runMessage, setRunMessage] = useState("");
  const [runEvents, setRunEvents] = useState([]);
  const runStreamRef = useRef(null);
  const [viewSprint, setViewSprint] = useState(null);
  const [viewState, setViewState] = useState("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [createdSprint, setCreatedSprint] = useState(null);
  const [highlightSprint, setHighlightSprint] = useState(null);
  const knownSprintIds = useRef(null);
  useEffect(() => () => runStreamRef.current?.close?.(), []);
  const currentId = dashboard?.current_sprint?.id ?? null;
  const sprints = dashboard?.roadmap?.sprints ?? [];
  useEffect(() => {
    const timer = setInterval(() => onRefresh?.(), 3000);
    return () => clearInterval(timer);
  }, [onRefresh]);
  useEffect(() => {
    const ids = new Set(sprints.map((sprint) => sprint.id));
    if (knownSprintIds.current) {
      const created = sprints.find((sprint) => !knownSprintIds.current.has(sprint.id));
      if (created) {
        setCreatedSprint(created);
        setHighlightSprint(created.id);
        const toastTimer = setTimeout(() => setCreatedSprint(null), 5000);
        const highlightTimer = setTimeout(() => setHighlightSprint(null), 3000);
        knownSprintIds.current = ids;
        return () => { clearTimeout(toastTimer); clearTimeout(highlightTimer); };
      }
    }
    knownSprintIds.current = ids;
  }, [sprints]);
  if (!sprints.length && !currentId) return null;

  async function handleRun(sprintId) {
    if (runningId) return;
    setRunningId(sprintId);
    setRunMessage("");
    try {
      const projectId = dashboard.project_id ?? PROJECT_ID;
      const result = await client.runSprintPlan(projectId, sprintId);
      setRunMessage(`Started ${result.sprint_id} — session ${result.session_id}`);
      setRunEvents(["Run accepted; waiting for agent events…"]);
      runStreamRef.current?.close?.();
      const conversationId = `CONV-BUILDER-${sprintId}`;
      runStreamRef.current = client.connectConversationStream({ projectId, conversationId, onMessage: (message) => {
        const type = message.message_type ?? "";
        const value = message.payload?.text ?? message.payload?.error ?? type;
        setRunEvents((events) => [...events.slice(-19), value]);
        if (type.endsWith(".message.received") || type.endsWith(".error") || type === "agent.completed" || type === "agent.failed" || type === "verification.result") setRunningId(null);
        if (type.endsWith(".error")) setRunMessage(`Run failed: ${value}`);
      }, onError: () => setRunMessage("Run stream disconnected; refresh history for final result.") });
      await onRefresh?.();
    } catch (error) {
      const msg = String(error?.message ?? "");
      if (error.status === 409 || msg.includes("409") || msg.toLowerCase().includes("already running")) {
        setRunMessage(`Sprint ${sprintId} is already running (409).`);
      } else {
        setRunMessage(`Run failed: ${msg}`);
      }
      setRunningId(null);
    }
  }

  async function handleView(sprintId) {
    setViewState("loading");
    setViewSprint(null);
    try { setViewSprint(await client.getSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId)); setViewState("ready"); }
    catch (error) { setViewState(error.message); }
  }
  async function handleDelete(sprintId) {
    if (!window.confirm(`Delete ${sprintId}? This removes file and database records.`)) return;
    try { await client.deleteSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId); setDeleteMessage(`Deleted ${sprintId}.`); await onRefresh?.(); }
    catch (error) { setDeleteMessage(`Delete failed: ${error.message}`); }
  }

  return <section className="sprint-plan-dashboard" aria-label="Uploaded sprint plans">
    <h2>Roadmap Sprints</h2>
    {createdSprint && <div className="sprint-created-toast" role="status" aria-live="polite">Sprint {createdSprint.id} created by Sprint Leader</div>}
    {dashboard?.current_sprint && <article className={`sprint-current ${highlightSprint === dashboard.current_sprint.id ? "is-new" : ""}`} aria-label={`Current sprint ${dashboard.current_sprint.id}`}>
      <div className="sprint-row">
        <div>
          <strong>{dashboard.current_sprint.id}</strong>
          <span className="sprint-badge">current</span>{highlightSprint === dashboard.current_sprint.id && <span className="sprint-new-badge">NEW</span>}
        </div>
          <span><button className="sprint-view-button" onClick={() => handleView(dashboard.current_sprint.id)}>View</button><button className="sprint-delete-button" onClick={() => handleDelete(dashboard.current_sprint.id)} disabled={Boolean(runningId) || dashboard.current_sprint.status === "done"}>Delete</button><button className={`sprint-run-button ${runningId === dashboard.current_sprint.id ? "is-running" : ""}`} onClick={() => handleRun(dashboard.current_sprint.id)} disabled={Boolean(runningId) || dashboard.current_sprint.status === "done"} aria-label={`Run ${dashboard.current_sprint.id}`}>
          {runningId === dashboard.current_sprint.id ? "Running…" : "Run"}
        </button>
          </span>
      </div>
      <p>{dashboard.current_sprint.objective}</p>
      <small>{dashboard.current_sprint.ticket_count ?? dashboard.current_sprint.tickets?.length ?? 0} tickets · {dashboard.current_sprint.status ?? "planned"}</small>
    </article>}
    {dashboard?.backlog?.length > 0 && <section className="sprint-ticket-list" aria-label="Tickets in current sprint"><h3>Tickets</h3>{dashboard.backlog.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} />)}</section>}
    {sprints.map((sprint) => {
      const isCurrent = sprint.id === currentId;
      if (isCurrent) return null;
      return <article key={sprint.id} className={`sprint-item ${highlightSprint === sprint.id ? "is-new" : ""}`}>
        <div className="sprint-row">
          <strong>{sprint.id}</strong>{highlightSprint === sprint.id && <span className="sprint-new-badge">NEW</span>}
        <span><button className="sprint-view-button small" onClick={() => handleView(sprint.id)}>View</button><button className="sprint-delete-button small" onClick={() => handleDelete(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"}>Delete</button><button className={`sprint-run-button small ${runningId === sprint.id ? "is-running" : ""}`} onClick={() => handleRun(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"} aria-label={`Run ${sprint.id}`}>
          {runningId === sprint.id ? "Running…" : "Run"}
          </button></span>
        </div>
        <p>{sprint.objective}</p>
        <small>{sprint.completed_ticket_count ?? 0}/{sprint.ticket_count ?? sprint.tickets?.length ?? 0} tickets completed · {sprint.status ?? "planned"}</small>
      </article>;
    })}
    {runMessage && <p className="sprint-run-message" role="status" aria-live="polite">{runMessage}</p>}
    {runEvents.length > 0 && <div className="sprint-run-events" role="log" aria-label="Sprint run events">{runEvents.map((event, index) => <div key={`${index}-${event}`}><strong>Run</strong> {event}</div>)}</div>}
    {deleteMessage && <p className="sprint-run-message" role="status">{deleteMessage}</p>}
    {viewState !== "idle" && <SprintPlanModal sprint={viewSprint} state={viewState} onClose={() => { setViewState("idle"); setViewSprint(null); }} />}
  </section>;
}

function UploadSprintPlanDialog({ client, onClose, onUploaded }) {
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState(null);
  const [errors, setErrors] = useState([]);
  const [state, setState] = useState("");
  async function choose(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setPlan(null); setState("");
    try {
      const parsed = JSON.parse(await file.text());
      const nextErrors = validateSprintPlan(parsed);
      setErrors(nextErrors);
      if (!nextErrors.length) setPlan(parsed);
    } catch { setErrors(["File must contain valid JSON."]); }
  }
  function drop(event) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    choose({ target: { files: [file] } });
  }
  async function submit() {
    if (!plan) return;
    setState("Uploading…");
    try { await client.uploadSprintPlan(plan.project_id, plan); await onUploaded?.(); setState("Uploaded successfully."); }
    catch (error) { setState(`Error: ${error.message}`); }
  }
  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Upload Sprint Plan"><section className="settings-modal upload-modal"><header><div><h2>Upload Sprint Plan</h2><p>Select a sprint-plan JSON file and preview it before submitting.</p></div><button onClick={onClose} aria-label="Close upload dialog">&#215;</button></header><label className="upload-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={drop}><input type="file" accept=".json,application/json" onChange={choose} aria-label="Sprint plan JSON file" /><strong>Drop sprint plan JSON here</strong><span>or click to browse</span></label>{fileName && <small className="upload-file">{fileName}</small>}{errors.length > 0 && <div className="upload-errors" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div>}{plan && <div className="upload-preview"><strong>{plan.id}</strong><p>{plan.objective}</p><span>Roadmap: {plan.roadmap_id} · Project: {plan.project_id}</span><span>{plan.tickets.length} tickets · {plan.exit_criteria.length} exit criteria</span></div>}<div className="settings-actions"><button onClick={submit} disabled={!plan || state === "Uploading…"}>Upload</button><button onClick={onClose}>Cancel</button></div>{state && <p aria-live="polite">{state}</p>}</section></div>;
}

function SprintPlanModal({ sprint, state, onClose }) {
  const closeButtonRef = useRef(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="sprint-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="sprint-modal" role="dialog" aria-modal="true" aria-labelledby="sprint-modal-title"><header><h2 id="sprint-modal-title">{sprint?.id ?? "Sprint Plan"}</h2><button ref={closeButtonRef} onClick={onClose} aria-label="Close sprint plan">&#215;</button></header>{state === "loading" && <p className="dashboard-state">Loading sprint plan…</p>}{state !== "loading" && !sprint && <p className="dashboard-state error">{state}</p>}{sprint && <div className="sprint-modal-content"><p className="sprint-objective">{sprint.objective}</p><h3>Tickets ({sprint.tickets.length})</h3><div className="sprint-ticket-table">{sprint.tickets.map((ticket) => <article key={ticket.id}><strong>{ticket.id}</strong><span>{ticket.title}</span><small>{ticket.priority ?? "normal"}</small></article>)}</div><h3>Exit Criteria</h3><ul>{sprint.exit_criteria.map((item) => <li key={item}>{item}</li>)}</ul></div>}</section></div>;
}

function InlineDecisionControls({ client, onWorkspaceChanged, workspace }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");
  const pending = getPendingArchitectureProposal(workspace);
  async function submit(decision) {
    if (!pending) return;
    const proposalId = pending.id;
    if (["REJECT", "CHANGE_REQUEST"].includes(decision) && !reason.trim()) { setResult("Reason is required."); return; }
    try {
      await client.postHumanDecision({ projectId: PROJECT_ID, decisionId: `HUMAN-${Date.now()}`, actor: "project-owner", proposalId, decision, reason: reason.trim(), correlationId: `CORR-DECISION-${Date.now()}` });
      setReason(""); setResult(labelForDecision(decision)); onWorkspaceChanged();
    } catch (error) { setResult(error.message); }
  }
  // Once a proposal is decided, keep the result in History rather than the chat composer.
  if (!pending) return null;
  return <section className="decision-actions" aria-label="Human Decision"><h3>Human Decision</h3><p>{pending.title ?? pending.id}</p><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for reject/change request" aria-label="Decision reason" /><div><button onClick={() => submit("APPROVE")}>Approve</button><button onClick={() => submit("CHANGE_REQUEST")}>Request Changes</button><button onClick={() => submit("REJECT")}>Reject</button></div>{result && <small>{result}</small>}</section>;
}

function getPendingArchitectureProposal(workspace) {
  const decisions = workspace?.decisions ?? [];
  const completed = new Set(decisions.filter((item) => item.type === "human_governance").map((item) => item.proposal_id));
  return decisions.find((item) => item.type !== "human_governance" && item.status === "proposed" && !completed.has(item.id)) ?? null;
}

function labelForDecision(decision) {
  if (decision === "APPROVE") return "✓ Approved";
  if (decision === "CHANGE_REQUEST") return "↻ Change Requested";
  if (decision === "REJECT") return "✕ Rejected";
  return "Decision recorded";
}

function HistoryOverlay({ client, onClose }) {
  const [agentId, setAgentId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [type, setType] = useState("");
  const [state, setState] = useState("loading");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const load = useCallback(async (cursor) => {
    setState("loading");
    try {
      const result = await client.getConversationAuditHistory({ projectId: PROJECT_ID, agentId: agentId || undefined, conversationId: conversationId || undefined, type: type || undefined, cursor });
      setItems((current) => cursor ? [...current, ...result.items] : result.items);
      setNextCursor(result.next_cursor);
      setState("ready");
    } catch { setState("error"); }
  }, [agentId, client, conversationId, type]);
  useEffect(() => { setItems([]); load(); }, [load]);
  return <div className="history-overlay" role="dialog" aria-modal="true" aria-label="Conversation and Audit History"><section className="history-modal"><header><div><h2>Conversation &amp; Audit History</h2><p>Read-only Node audit trail</p></div><button onClick={onClose} aria-label="Close history">&#215;</button></header><div className="history-filters"><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">All agents</option>{AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select><input value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="conversation_id" /><input value={type} onChange={(event) => setType(event.target.value)} placeholder="message/event type" /></div><div className="history-list">{state === "loading" && <p>Loading persisted history from Node…</p>}{state === "error" && <p className="error">Node could not load history.</p>}{state === "ready" && !items.length && <p>No persisted conversation or audit records match this filter.</p>}{items.map((item) => <article key={`${item.kind}-${item.id}`} className={`history-item ${item.kind}`}><div><strong>{item.kind}</strong><span>{item.type}</span></div><p>{JSON.stringify(item.content)}</p><small>{item.timestamp} · {item.sender} → {item.receiver}{item.conversation_id ? ` · ${item.conversation_id}` : ""}{item.correlation_id ? ` · ${item.correlation_id}` : ""}</small></article>)}{nextCursor && <button className="history-more" onClick={() => load(nextCursor)}>Load more</button>}</div></section></div>;
}

function AgentSettingsOverlay({ client, agent, onClose }) {
  const [profile, setProfile] = useState(null); const [url, setUrl] = useState(""); const [key, setKey] = useState(""); const [provider, setProvider] = useState("codex"); const [model, setModel] = useState(""); const [enabled, setEnabled] = useState(false); const [message, setMessage] = useState("");
  const models = MODEL_CATALOG[provider] ?? [];
  useEffect(() => { client.getAgentSettings().then((items) => { const item = items.find(({ agent_id: id }) => id === agent.id); if (item) { setProfile(item); setUrl(item.gateway_url ?? ""); setEnabled(Boolean(item.enabled)); setProvider(item.provider ?? "codex"); setModel(item.model ?? ""); } }).catch((error) => setMessage(`Error: ${error.message}`)); }, [agent.id, client]);
  function changeProvider(value) {
    const nextModels = MODEL_CATALOG[value] ?? [];
    setProvider(value);
    setModel(nextModels.some((item) => item.value === model) ? model : "");
  }
  async function save() { try { const item = await client.saveAgentSettings(agent.id, { agent_name: profile?.agent_name ?? agent.label, gateway_url: url, provider, model: models.length ? model : "", enabled, ...(key ? { api_key: key } : {}) }); setProfile(item); setKey(""); setMessage("Saved. API key remains masked in Node."); } catch (error) { setMessage(`Error: ${error.message}`); } }
  async function testConnection() { try { const result = await client.testAgentConnection(agent.id); setMessage(`Connected: ${result.status}`); } catch (error) { setMessage(`Failed: ${error.message}`); } }
  return <div className="settings-overlay" role="dialog" aria-modal="true"><section className="settings-modal"><header><h2>{agent.label} Settings</h2><button onClick={onClose} aria-label="Close Agent Settings">&#215;</button></header><label>Provider<select value={provider} onChange={(event) => changeProvider(event.target.value)} aria-label="Provider">{PROVIDER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label><label>Model<select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model" disabled={!models.length}><option value="">{models.length ? "Select model" : "No model catalog for this provider"}</option>{models.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label><label>Gateway URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label><label>API Key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="********" autoComplete="new-password" /></label><label className="settings-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label><div className="settings-actions"><button onClick={save}>Save Profile</button><button onClick={testConnection}>Test Connection</button></div>{profile?.api_key_masked && <small className="settings-mask">API key masked: {profile.api_key_masked}</small>}{message && <p aria-live="polite">{message}</p>}</section></div>;
}

function toDisplayMessage(message) {
  const isOwner = message.sender?.role === "project_owner";
  const text = message.payload?.text
    ?? message.payload?.content
    ?? (message.message_type === "architecture.working" ? "Architecture Manager is working…" : message.message_type === "architecture.message.received" ? "Architecture plan recorded in Node." : message.message_type);
  return { id: message.message_id, correlation_id: message.correlation_id, message_type: message.message_type, from: isOwner ? "owner" : message.message_type.includes("error") ? "system" : "agent", text, time: new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
}

function mergeStreamMessage(messages, message) {
  if (messages.some((item) => item.id === message.message_id)) return messages;
  // Tool results and synthetic progress are private Node<->agent traffic; keep them in history/SSE replay but do not render in chat bubbles.
  if (message.message_type.endsWith(".tool.result")) return messages;
  if (message.message_type.endsWith(".message.progress") || message.message_type.endsWith(".progress")) return messages;
  if (message.message_type.endsWith(".working")) return messages;
  const isDelta = message.message_type.endsWith(".message.delta");
  const isCompletion = message.message_type.endsWith(".message.received");
  if (!isDelta && !isCompletion) return [...messages, toDisplayMessage(message)];
  const index = messages.findIndex((item) => item.from === "agent" && item.correlation_id === message.correlation_id && item.stream === true);
  if (index < 0) return [...messages, { ...toDisplayMessage(message), stream: true, text: message.payload?.text ?? "" }];
  const next = [...messages];
  const current = next[index];
  next[index] = { ...current, id: message.message_id, message_type: message.message_type, text: isDelta ? `${current.text}${message.payload?.text ?? ""}` : (message.payload?.text ?? current.text), stream: !isCompletion };
  return next;
}

function ArchitecturePanel({ client, onWorkspaceChanged, onSettings, agent, workspace, messages, draft, onDraft, onSend, onActivate, active }) {
  const conversationRef = useRef(null);
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const element = conversationRef.current;
    if (element && wasAtBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  return <article className={`agent-panel architecture-workspace ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} onSettings={onSettings} />
    <div className="architecture-conversation conversation natural-conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label="Architecture Manager messages">
      <div className="date-rule"><span>Conversation</span></div>
      {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      {agent.status === "WORKING" && <div className="working-status" role="status">Architecture Manager is working…</div>}
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onInput={(event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} rows="2" placeholder="Message Architecture Manager..." aria-label="Message Architecture Manager" /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}

function ArchitectureArtifacts({ workspace }) {
  const proposal = getPendingArchitectureProposal(workspace);
  if (!proposal) return null;
  return <aside className="architecture-artifacts pending-proposal" aria-label="Proposal awaiting human decision">
    <div className="workspace-section"><h3>Proposal Awaiting Decision</h3><div className="workspace-card"><strong>{proposal.title ?? proposal.id}</strong><p>{proposal.decision}</p><span>Architecture Manager proposal</span></div></div>
  </aside>;
}

function HumanDecisionActions({ client, onWorkspaceChanged, proposal }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");
  async function submit(decision) {
    if (!proposal) { setResult("No architecture proposal is available."); return; }
    if (["REJECT", "CHANGE_REQUEST"].includes(decision) && !reason.trim()) { setResult("Reason is required."); return; }
    try {
      await client.postHumanDecision({ projectId: PROJECT_ID, decisionId: `HUMAN-${Date.now()}`, actor: "project-owner", proposalId: proposal.id, decision, reason: reason.trim(), correlationId: `CORR-DECISION-${Date.now()}` });
      setReason(""); setResult(`${decision} recorded by Node.`); onWorkspaceChanged();
    } catch (error) { setResult(error.message); }
  }
  return <section className="decision-actions"><h3>Human Decision</h3><p>{proposal ? `Proposal: ${proposal.id}` : "Waiting for an architecture proposal."}</p><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for reject/change request" aria-label="Decision reason" /><div><button onClick={() => submit("APPROVE")}>Approve</button><button onClick={() => submit("REJECT")}>Reject</button><button onClick={() => submit("CHANGE_REQUEST")}>Change request</button></div>{result && <small>{result}</small>}</section>;
}

function ProjectDashboardPanel({ agent, dashboard, state, onActivate, active, onSettings }) {
  return <article className={`agent-panel dashboard-panel ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} onSettings={onSettings} />
    <div className="dashboard-content" aria-label="Project and Sprint Dashboard">
      {state === "loading" && <p className="dashboard-state">Loading dashboard from Node…</p>}
      {state === "error" && <p className="dashboard-state error">Node could not load the Project Dashboard.</p>}
      {state === "ready" && <DashboardData dashboard={dashboard} client={client} onRefresh={loadDashboard} />}
    </div>
  </article>;
}

function DashboardData({ dashboard, client, onRefresh }) {
  if (!dashboard?.roadmap || !dashboard.current_sprint) return <p className="dashboard-state">No roadmap or current sprint has been published yet.</p>;
  const sprint = dashboard.current_sprint;
  return <>
    <div className="dashboard-overview"><span>ROADMAP <strong>{dashboard.roadmap.id}</strong></span><span>v{dashboard.roadmap.version}</span><span>{sprint.status.toUpperCase()}</span></div>
    <section className="dashboard-section"><h3>{sprint.id}</h3><p>{sprint.objective}</p><small>{sprint.completed_ticket_count}/{sprint.ticket_count} tickets completed</small></section>
    <section className="dashboard-section"><h3>Sprint Backlog</h3>{dashboard.backlog.length ? <div className="dashboard-tickets">{dashboard.backlog.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} />)}</div> : <p className="dashboard-state">No tickets in the current sprint.</p>}</section>
    <section className="dashboard-section roadmap-list"><h3>Roadmap Sprints</h3>{dashboard.roadmap.sprints.map((item) => <div key={item.id}><span>{item.order}. {item.id}</span><small>{item.status}</small></div>)}</section>
  </>;
}

function TicketCard({ ticket, client, projectId, onRefresh }) {
  const [message, setMessage] = useState("");
  async function run() {
    try {
      await client.postOwnerMessage({ projectId, conversationId: "CONV-BUILDER", agentId: "builder", messageId: `MSG-UI-RUN-${ticket.id}-${Date.now()}`, correlationId: `CORR-UI-RUN-${ticket.id}-${Date.now()}`, text: `/ticket ${ticket.id}` });
      setMessage("Run requested");
      await onRefresh?.();
    } catch (error) { setMessage(error.message); }
  }
  async function remove() {
    if (!window.confirm(`Delete ticket ${ticket.id}?`)) return;
    try { await client.deleteTicket(projectId, ticket.id); setMessage("Deleted"); await onRefresh?.(); }
    catch (error) { setMessage(error.message); }
  }
  return <article className="dashboard-ticket"><div><strong>{ticket.id}</strong><span className="priority">{ticket.priority}</span></div><p>{ticket.title}</p><small>{ticket.status} · {ticket.progress}%</small><div><button onClick={run} disabled={ticket.status === "done" || ticket.status === "running"}>Run</button><button onClick={remove} disabled={ticket.status === "done" || ticket.status === "running"}>Delete</button></div>{message && <small>{message}</small>}{ticket.provenance && <small className="provenance">{ticket.provenance.architecture_decision_ids.join(", ")} → {ticket.provenance.roadmap_id} → {ticket.provenance.sprint_id}</small>}</article>;
}

function WorkspaceSection({ title, items, empty }) {
  return <section className="workspace-section"><h3>{title}</h3>{items.length ? <div className="workspace-items">{items.map((item) => <div className="workspace-card" key={item.id}><strong>{item.title ?? item.id}</strong>{item.decision && <p>{item.decision}</p>}{item.objective && <p>{item.objective}</p>}{item.status && <span>{item.status}</span>}{item.tickets && <span>{item.tickets.length} ticket{item.tickets.length === 1 ? "" : "s"}</span>}</div>)}</div> : <p className="workspace-empty">{empty}</p>}</section>;
}

function PanelHeader({ agent, onSettings }) {
  return <header className="agent-header"><div className={`agent-avatar ${agent.tone}`}>{agent.short}</div><div className="agent-heading"><h2>{agent.label}</h2><div className="agent-status"><span className="status-dot" /> {agent.status}</div></div><button className="panel-menu" onClick={onSettings} title="Agent Settings" aria-label={`${agent.label} Agent Settings`}>&#9881;</button></header>;
}

function Message({ message }) {
  const streaming = message.stream === true;
  const rowClass = `message-row natural-message ${message.from === "owner" ? "owner" : `agent${streaming ? " streaming" : ""}`}`;
  return <div id={`msg-${message.id}`} className={rowClass} data-message-id={message.id} data-correlation-id={message.correlation_id ?? ""} data-message-type={message.message_type ?? ""} data-role={message.from} data-timestamp={message.timestamp ?? ""}><MessageContent text={message.text} /><time dateTime={message.timestamp ?? ""} title={message.timestamp ?? ""}>{message.time}</time></div>;
}

function MessageContent({ text }) {
  const parts = parseCodeBlocks(text);
  return <div className="message-content">{parts.map((part, index) => part.code
    ? <CodeBlock key={`code-${index}`} language={part.language} code={part.code} />
    : <TextWithInline key={`text-${index}`} text={part.text} />)}</div>;
}

function TextWithInline({ text }) {
  const value = String(text ?? "");
  if (!value) return null;
  const segments = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    const start = match.index;
    if (start > last) segments.push({ text: value.slice(last, start) });
    segments.push({ inlineCode: match[1] });
    last = start + match[0].length;
  }
  if (last < value.length) segments.push({ text: value.slice(last) });
  if (segments.length === 0) return <p>{value}</p>;
  const hasInline = segments.some((s) => s.inlineCode);
  if (!hasInline) return <p>{value}</p>;
  return <p>{segments.map((seg, i) => seg.inlineCode ? <InlineCode key={i} code={seg.inlineCode} /> : <span key={i}>{seg.text}</span>)}</p>;
}

function InlineCode({ code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { setCopied(false); }
  }
  return <span className="inline-code-wrap"><code className="inline-code">{code}</code><button type="button" className="inline-copy" onClick={copy} aria-label="Copy command">{copied ? "Copied" : "Copy"}</button></span>;
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  return <div className="code-block"><div className="code-block-header"><span>{language || "code"}</span><button type="button" className={copied ? "is-copied" : ""} onClick={copy}>{copied ? "Copied" : "Copy"}</button></div><pre><code>{code}</code></pre></div>;
}

function parseCodeBlocks(text) {
  const value = String(text ?? "");
  const parts = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ code: match[2].replace(/\n$/, ""), language: match[1].trim() });
    cursor = start + match[0].length;
  }
  if (cursor < value.length || parts.length === 0) parts.push({ text: value.slice(cursor) });
  return parts;
}

function AgentPanel({ agent, messages, draft, onDraft, onSend, onActivate, active, expanded, onSettings }) {
  const conversationRef = useRef(null);
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const element = conversationRef.current;
    if (!element) return;
    if (wasAtBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  return <article className={`agent-panel panel ${expanded ? "expanded" : ""} ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} onSettings={onSettings} />
    <div className="conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label={`${agent.label} messages`}>
      <div className="date-rule"><span>Today</span></div>
      {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      <div className="typing-line"><span className="typing-dots"><i /><i /><i /></span> Node is listening</div>
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder={`Message ${agent.label}...`} aria-label={`Message ${agent.label}`} /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}

createRoot(document.getElementById("root")).render(<App />);
