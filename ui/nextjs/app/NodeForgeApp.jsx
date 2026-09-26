// Main NodeForge app orchestrating agents, chat and dashboard streams.
"use client";
/* Legacy Vite parity copy: retain dormant components until the Next UI is fully consolidated. */
/* eslint-disable no-unused-vars, no-undef */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNodeClient, MESSAGE_INTENTS } from "../lib/node-client.js";
import { toDisplayMessage } from "../components/NodeForgePanels.jsx";
import { NodeForgeShell } from "../components/NodeForgeShell.jsx";
import { AGENTS, PROJECT_ID, CONVERSATIONS, CHAT_PAGE_SIZE } from "../lib/node-forge-app-constants.js";
import { formatDateLabel, historyRecordToMessage } from "../lib/node-forge-history-format.js";
import { createHistoryStreamController } from "../lib/node-forge-history-stream.js";
import { useAgentEventStreams } from "../lib/node-forge-agent-streams.js";
import { createSendMessageHandler } from "../lib/node-forge-send-message.js";

// Root app managing agents, history, and real-time streams.
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
        return { ...m, [agentId]: merged };
      });
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

  const { pushLiveHistory, isAtBottom, queueHistoryDelta, finalizeHistoryDelta, scrollToBottom, handleScroll } = createHistoryStreamController({
    conversationRefs, wasAtBottomRef, streamQueues, streamingIdsRef, pendingLive, historyChat, setHistoryChat,
    historyLoadingRef, historyHasMoreRef, loadHistoryPage, toDisplayMessage, historyRecordToMessage, formatDateLabel
  });

  useEffect(() => { for (const a of AGENTS) loadHistoryPage(a.id, "initial"); }, [loadHistoryPage]);
  useEffect(() => { loadAgents(); }, [loadAgents]);

  useAgentEventStreams({
    client, lastMessageId, pendingDispatchRef, dispatchTimersRef, setWorkingByAgent,
    queueHistoryDelta, finalizeHistoryDelta, pushLiveHistory, sseReplayRef,
    scheduleDashboardRefresh, loadWorkspace, loadDashboard, dashboardRefreshTimerRef
  });

  const send = createSendMessageHandler({
    client, drafts, setDrafts, selectedArchitectureManager, setHistoryChat, pendingLive,
    setWorkingByAgent, pushLiveHistory, scrollToBottom, MESSAGE_INTENTS
  });

  const isWorking = workingByAgent[activeAgent] === "WORKING";

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

  return <NodeForgeShell app={{ AGENTS, active, activeAgent, workingByAgent, drafts, historyChat, historyHasMore, historyLoading, conversationRefs, composerRef, setActiveAgent, setDrafts, historyOpen, setHistoryOpen, settingsAgent, setSettingsAgent, uploadOpen, setUploadOpen, send, handleScroll, dashboard, workspace, client, loadWorkspace, loadDashboard, wasAtBottomRef, architectureManagers, selectedArchitectureManagerId, setSelectedArchitectureManagerId }} />;
}

export default App;
