"use client";
/* Legacy Vite parity copy: retain dormant components until the Next UI is fully consolidated. */
/* eslint-disable no-unused-vars, no-undef */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNodeClient, detectMessageIntent, normalizeTicketInput, MESSAGE_INTENTS } from "../lib/node-client.js";
import { toDisplayMessage } from "../components/NodeForgePanels.jsx";
import { NodeForgeShell } from "../components/NodeForgeShell.jsx";
import { validateSprintPlan } from "../lib/sprint-plan-validator.js";

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
  const isOwner = record.kind === "owner";
  const raw = record.content;
  const text = eventTextForUser(record.type, raw) ?? raw?.text ?? raw?.content ?? formatTicketResponse({ message_type: record.type, payload: raw }) ?? (typeof raw === "string" ? raw : JSON.stringify(raw ?? ""));
  const from = isOwner ? "owner" : record.kind === "failure" ? "system" : record.kind === "agent" || record.kind === "completion" ? "agent" : isOwner ? "owner" : "agent";
  const ts = record.timestamp;
  const d = ts ? new Date(ts) : new Date();
  return { id: record.id, correlation_id: record.correlation_id, message_type: record.type, from, text: String(text ?? record.type), time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: ts, dateKey: Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10), dateLabel: ts ? formatDateLabel(ts) : "" };
}

function isInternalNodeEvent(type) {
  const value = String(type ?? "");
  return value.endsWith(".tool.result");
}

function eventTextForUser(type, payload = {}) {
  const value = String(type ?? "");
  const step = payload?.result?.step_name ?? payload?.step_name;
  if (value.endsWith(".message.progress") || value.endsWith(".progress")) return payload?.message ?? payload?.text ?? "Node đang xử lý…";
  if (value.endsWith(".working")) return "Builder đang làm việc…";
  if (value === "node.status_change") {
    const status = payload?.to ?? payload?.status;
    return status === "running" ? "Builder bắt đầu chạy ticket." : status === "reviewing" ? "Builder đã hoàn tất, đang chờ review." : status === "done" ? "Ticket đã hoàn tất." : status === "failed" ? `Ticket thất bại${payload?.error ? `: ${payload.error}` : "."}` : `Trạng thái ticket: ${status ?? "đã cập nhật"}.`;
  }
  if (value === "node.execution_step") return step ? `Đang xử lý: ${humanizeStep(step)}.` : "Đang xử lý một bước thực thi…";
  if (value === "node.command_result") return payload?.success === false ? `Bước thực thi thất bại${payload?.result?.error_code ? ` (${payload.result.error_code})` : "."}` : step ? `Đã hoàn tất: ${humanizeStep(step)}.` : "Đã hoàn tất một bước thực thi.";
  if (value === "git.status") return "Đã kiểm tra thay đổi Git.";
  if (value === "git.add") return "Đã chuẩn bị các file thay đổi cho commit.";
  if (value === "git.commit") return payload?.commit ? `Đã commit thay đổi (${payload.commit}).` : "Đã commit thay đổi.";
  if (value === "ticket.input_rejected") return payload?.error ?? "Ticket đang chạy; yêu cầu mới chưa được nhận.";
  return null;
}

function humanizeStep(step) {
  return String(step).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
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
  const [agentDirectory, setAgentDirectory] = useState([]);
  const [selectedArchitectureManagerId, setSelectedArchitectureManagerId] = useState("");
  const [workspace, setWorkspace] = useState(null);
  const workspaceRequestRef = useRef(null);
  const [workingByAgent, setWorkingByAgent] = useState(() => Object.fromEntries(AGENTS.map((agent) => [agent.id, "READY"])));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const dashboardRequestRef = useRef(null);
  const dashboardRequestVersionRef = useRef(0);
  const dashboardRefreshTimerRef = useRef(null);
  const sseReplayRef = useRef(Object.fromEntries(AGENTS.map((agent) => [agent.id, true])));
  const [historyChat, setHistoryChat] = useState(() => Object.fromEntries(AGENTS.map((a) => [a.id, []])));
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
  const architectureManagers = useMemo(() => agentDirectory
    .filter((agent) => agent?.role === "architecture_manager" && agent?.enabled === true)
    .map((agent) => ({
      ...agent,
      id: agent.agent_id ?? agent.id,
      label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id,
      short: String(agent.agent_name ?? agent.name ?? agent.label ?? "AM").slice(0, 2).toUpperCase(),
      tone: "violet"
    }))
    .filter((agent) => agent.id), [agentDirectory]);
  const selectedArchitectureManager = architectureManagers.find((agent) => agent.id === selectedArchitectureManagerId) ?? architectureManagers[0] ?? null;
  const active = AGENTS.find((agent) => agent.id === activeAgent);
  useEffect(() => {
    if (selectedArchitectureManager?.id !== selectedArchitectureManagerId) setSelectedArchitectureManagerId(selectedArchitectureManager?.id ?? "");
  }, [selectedArchitectureManager?.id, selectedArchitectureManagerId]);
  const loadAgents = useCallback(async () => {
    try {
      const payload = await client.getAgents();
      setAgentDirectory(Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? []);
    } catch {
      setAgentDirectory([]);
    }
  }, [client]);
  const loadWorkspace = useCallback(async () => {
    if (workspaceRequestRef.current) return workspaceRequestRef.current;
    const request = (async () => {
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
    })();
    workspaceRequestRef.current = request;
    try { return await request; } finally { workspaceRequestRef.current = null; }
  }, [client]);
  const loadDashboard = useCallback(async () => {
    if (dashboardRequestRef.current) return dashboardRequestRef.current.promise;
    const requestVersion = ++dashboardRequestVersionRef.current;
    const request = (async () => {
    try {
      const primary = await client.getProjectDashboard(PROJECT_ID);
      // The API/database is the sole source of ticket status. SSE only
      // triggers a refresh and never mutates ticket status in React state.
      if (requestVersion === dashboardRequestVersionRef.current) setDashboard(primary);
    } catch {
      if (requestVersion === dashboardRequestVersionRef.current) setDashboard(null);
    }
    })();
    dashboardRequestRef.current = { promise: request, version: requestVersion };
    try { return await request; } finally {
      if (dashboardRequestRef.current?.promise === request) dashboardRequestRef.current = null;
    }
  }, [client]);

  const scheduleDashboardRefresh = useCallback(() => {
    if (dashboardRefreshTimerRef.current) return;
    dashboardRefreshTimerRef.current = setTimeout(() => {
      dashboardRefreshTimerRef.current = null;
      void loadDashboard();
    }, 250);
  }, [loadDashboard]);

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
  useEffect(() => { loadAgents(); }, [loadAgents]);

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
            || (message.message_type === "node.status_change" && message.payload?.to === "running" && (message.correlation_id === pendingCorrelation || agent.id === "builder"))
          );
          if (isRunningEvent) {
            clearTimeout(dispatchTimersRef.current[agent.id]);
            delete dispatchTimersRef.current[agent.id];
            delete pendingDispatchRef.current[agent.id];
            setWorkingByAgent((prev) => ({ ...prev, [agent.id]: "WORKING" }));
          }
          if (message.message_type === "node.status_change" && ["done", "failed", "reviewing"].includes(message.payload?.to) && (message.correlation_id === pendingCorrelation || agent.id === "builder")) {
            clearTimeout(dispatchTimersRef.current[agent.id]);
            delete dispatchTimersRef.current[agent.id];
            delete pendingDispatchRef.current[agent.id];
            setWorkingByAgent((prev) => ({ ...prev, [agent.id]: message.payload.to === "failed" ? "FAILED" : message.payload.to === "reviewing" ? "REVIEWING" : "READY" }));
          }
          if (message.message_type.endsWith(".message.received") || message.message_type.endsWith(".error")) setWorkingByAgent((prev) => ({ ...prev, [agent.id]: message.payload?.agent_status ?? (message.message_type.endsWith(".error") ? "FAILED" : "COMPLETED") }));
          if (message.message_type.endsWith(".message.delta")) {
            queueHistoryDelta(agent.id, message);
          } else if (message.message_type.endsWith(".message.received")) {
            finalizeHistoryDelta(agent.id, message);
            pushLiveHistory(agent.id, message);
          } else {
            pushLiveHistory(agent.id, message);
          }
          if (!sseReplayRef.current[agent.id] && (message.message_type === "governance.sprint_plan.created" || message.message_type === "ticket.creation")) scheduleDashboardRefresh();
          if (!sseReplayRef.current[agent.id] && message.message_type === "node.status_change" && message.payload?.ticket_id) {
            // SSE is a live signal only; API remains the canonical ticket source.
            scheduleDashboardRefresh();
          }
          if (agent.id === "architecture-manager" && message.message_type === "architecture.message.received") loadWorkspace();
        },
        onReplayComplete: () => {
          sseReplayRef.current[agent.id] = false;
          setWorkingByAgent((prev) => ({ ...prev, [agent.id]: prev[agent.id] === "WORKING" ? "READY" : prev[agent.id] }));
        },
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
    return () => {
      streams.forEach((stream) => stream.close());
      if (dashboardRefreshTimerRef.current) clearTimeout(dashboardRefreshTimerRef.current);
      dashboardRefreshTimerRef.current = null;
    };
  }, [client, loadDashboard, loadWorkspace, scheduleDashboardRefresh]);

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
    // Chat composer always targets the selected conversation. Ticket creation
    // is handled by the sprint form; only an explicit /ticket command dispatches.
    const intent = /^\/ticket(?:\s|$)/i.test(text) ? detectMessageIntent(text) : MESSAGE_INTENTS.normalChat;
    const extractedTicket = intent === MESSAGE_INTENTS.ticketCreate ? normalizeTicketInput(text).ticket : undefined;
    const isDispatch = intent === MESSAGE_INTENTS.ticketDispatch;
    const targetAgentId = intent === MESSAGE_INTENTS.normalChat
      ? (agentId === "architecture-manager" ? selectedArchitectureManager?.id : agentId)
      : "builder";
    if (intent === MESSAGE_INTENTS.normalChat && agentId === "architecture-manager" && !selectedArchitectureManager) {
      setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), { id: `ERR-${Date.now()}`, from: "system", text: "No enabled Architecture Manager is available. Select an enabled agent before sending a message.", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), message_type: "system.invalid_target" }] }));
      return;
    }
    const selectedConversationId = selectedArchitectureManager?.conversation_id ?? selectedArchitectureManager?.conversationId;
    const conversationId = intent === MESSAGE_INTENTS.normalChat && agentId === "architecture-manager"
      ? (selectedConversationId ?? CONVERSATIONS[targetAgentId] ?? ARCHITECTURE_CONVERSATION_ID)
      : (CONVERSATIONS[targetAgentId] ?? ARCHITECTURE_CONVERSATION_ID);
    const messageId = `MSG-OWNER-${Date.now()}-${targetAgentId}`;
    const nowIso = new Date().toISOString();
    const nowDate = new Date(nowIso);
    const optimistic = { id: messageId, correlation_id: `CORR-${agentId}-${Date.now()}`, message_type: "owner.message", from: "owner", text, time: nowDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: nowIso, dateKey: nowIso.slice(0, 10), dateLabel: formatDateLabel(nowIso) };
    setDrafts((current) => ({ ...current, [agentId]: "" }));
    if (isDispatch) pendingDispatchRef.current[agentId] = optimistic.correlation_id;
    setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), optimistic] }));
    pendingLive.current[agentId] = [...(pendingLive.current[agentId] ?? []), optimistic];
    requestAnimationFrame(() => scrollToBottom(agentId));
    try {
      const response = await client.postOwnerMessage({
        projectId: PROJECT_ID,
        conversationId,
        agentId: targetAgentId,
        messageId,
        correlationId: optimistic.correlation_id,
        text,
        intent,
        ticket: extractedTicket
      });
      // Some immediate Node responses (ticket.creation/status) can arrive
      // before the SSE subscription observes the persisted message. Render
      // the POST response as a fallback; SSE deduplication prevents doubles.
      if (response?.message_type && (response.message_id || response.id)) {
        pushLiveHistory(targetAgentId, { ...response, message_id: response.message_id ?? response.id });
      }
      if (response?.message_type === "ticket.creation") {
        const status = response.payload?.status;
        if (status === "created") {
          clearTimeout(dispatchTimersRef.current[agentId]);
          delete dispatchTimersRef.current[agentId];
          delete pendingDispatchRef.current[agentId];
          setWorkingByAgent((current) => ({ ...current, [agentId]: "READY" }));
          await loadDashboard();
        } else if (status) {
          setWorkingByAgent((current) => ({ ...current, [agentId]: "FAILED" }));
        }
      }
      if (!isDispatch) return;
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

  const isWorking = workingByAgent[activeAgent] === "WORKING";
  const dashboardSprints = dashboard?.roadmap?.sprints ?? [];
  const dashboardTickets = dashboardSprints.flatMap((sprint) => sprint.tasks ?? []);
  const runningTickets = dashboardTickets.filter((ticket) => ticket.status === "running").length;
  const completedTickets = dashboardTickets.filter((ticket) => ticket.status === "done").length;
  const activeAgents = AGENTS.filter((agent) => workingByAgent[agent.id] === "WORKING").length;

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


  return <NodeForgeShell app={{ AGENTS, active, activeAgent, workingByAgent, drafts, historyChat, historyHasMore, historyLoading, conversationRefs, composerRef, setActiveAgent, setDrafts, historyOpen, setHistoryOpen, settingsAgent, setSettingsAgent, uploadOpen, setUploadOpen, send, handleScroll, dashboard, workspace, client, loadWorkspace, loadDashboard, wasAtBottomRef, architectureManagers, selectedArchitectureManagerId, setSelectedArchitectureManagerId }} />;
}

export default App;
