"use client";
// HomePage — main workspace with dashboard and real-time updates.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { NodeForgeHeader } from "../components/NodeForgeHeader.jsx";
import { AgentProcessStatus, MessageContent, SprintPlanDashboard, UploadSprintPlanDialog } from "../components/NodeForgePanels.jsx";
import { ConversationsAccordion } from "../components/ConversationsAccordion.jsx";
import { createNodeClient, MESSAGE_INTENTS } from "../lib/node-client.js";
import { architectureManagerSelection, writeArchitectureManagerAgent } from "../../src/architecture-manager-selection.js";

const PROJECT_ID = "PROJECT-NODEFORGE";
const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";
const SPRINT_CACHE_KEY = `nodeforge:sprints:${PROJECT_ID}`;
const CHAT_STATE_KEY = `nodeforge:chat:last:${PROJECT_ID}`;

// Converts raw sprint plans into dashboard view data.
function toDashboard(sprintPlans) {
  const plans = Array.isArray(sprintPlans) ? sprintPlans : sprintPlans?.items ?? sprintPlans?.sprints ?? [];
  return { project_id: PROJECT_ID, roadmap: { id: plans[0]?.roadmap_id ?? `ROADMAP-${PROJECT_ID}`, version: plans.at(-1)?.id ?? "latest", sprints: plans.map((sprint, index) => ({ id: sprint.id, objective: sprint.objective, order: index + 1, status: sprint.status ?? "planned", tasks: (sprint.tickets ?? []).map((ticket) => ({ ...ticket, status: ticket.status ?? "planned", progress: ticket.status === "done" ? 100 : ticket.status === "running" || ticket.status === "reviewing" ? 50 : 0 })) })) } };
}

// Reads cached sprint plan data from storage.
function readSprintCache() {
  if (typeof window === "undefined") return null;
  try { return toDashboard(JSON.parse(window.sessionStorage.getItem(SPRINT_CACHE_KEY) ?? "null")); } catch { return null; }
}

// Reads the last chat selection so reload can restore the same conversation.
function readChatState() {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(CHAT_STATE_KEY) ?? "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Persists the active agent and conversation for the next page load.
function writeChatState(agentId, conversationId) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(CHAT_STATE_KEY, JSON.stringify({ agent_id: agentId, conversation_id: conversationId })); } catch { /* storage is optional */ }
}

// Normalizes watcher events into a consistent array format.
function normalizeWatcherEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => Array.isArray(event?.payload?.activity) && event.payload.activity.length > 0)
    .sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
    .slice(-4);
}

// Applies a watcher event to the current state.
function applyWatcherEvent(current, event) {
  if (event?.event_type === "stream.snapshot") return normalizeWatcherEvents(event.payload?.watcher?.recent_events);
  if (!["watcher.file_indexed", "watcher.file_removed"].includes(event?.event_type) || !Array.isArray(event.payload?.activity)) return current;
  return normalizeWatcherEvents([...current, event]);
}

// Formats a timestamp for message display.
function displayMessageTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Checks whether a conversation id is compatible with the persisted conversation API.
function isPersistedConversationId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));
}

// Creates a globally unique client identifier for chat tracing and deduplication.
function createChatId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `${prefix}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

// Resolves an agent id to the configured display name used by the chat UI.
function agentDisplayName(agentId, agents) {
  const agent = agents.find((item) => (item.agent_id ?? item.id) === agentId);
  return agent?.agent_name ?? agent?.name ?? agent?.label ?? agentId ?? "Agent";
}

// Main workspace page with dashboard and live event handling.
export default function HomePage() {
  const client = useMemo(() => createNodeClient(), []);
  const chatMessagesRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [agentDirectory, setAgentDirectory] = useState([]);
  const [selectedArchitectureManagerId, setSelectedArchitectureManagerId] = useState("");
  const [chatState, setChatState] = useState("");
  const [dashboard, setDashboard] = useState(null);
  const [dashboardState, setDashboardState] = useState("loading");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [watcherEvents, setWatcherEvents] = useState([]);
  const [watcherState, setWatcherState] = useState("connecting");
  const [watcherPulseId, setWatcherPulseId] = useState(0);
  const [agentProcess, setAgentProcess] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const lastSentRef = useRef(null);
  const sendingRef = useRef(false);

  const architectureManagers = useMemo(() => agentDirectory
    .filter((agent) => agent?.role === "architecture_manager" && agent?.enabled === true)
    .map((agent) => ({
      ...agent,
      id: agent.agent_id ?? agent.id,
      label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id
    }))
    .filter((agent) => agent.id), [agentDirectory]);
  const selectedArchitectureManager = architectureManagers.find((agent) => agent.id === selectedArchitectureManagerId) ?? null;

  const streamConversationId = activeConversationId ?? selectedArchitectureManager?.conversation_id ?? selectedArchitectureManager?.conversationId ?? ARCHITECTURE_CONVERSATION_ID;
  activeConversationIdRef.current = streamConversationId;
  agentDirectoryRef.current = agentDirectory;

  useEffect(() => {
    let active = true;
    client.getAgents()
      .then((payload) => {
        if (!active) return;
        const agents = Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? [];
        setAgentDirectory(agents);
        const primary = agents.find((a) => a?.process || a?.processStatus || a?.agentProcess || a?.pid != null) ?? agents[0] ?? null;
        if (primary) setAgentProcess(primary);
        const storedAgentId = architectureManagerSelection(PROJECT_ID, "");
        if (agents.some((agent) => (agent.agent_id ?? agent.id) === storedAgentId && agent.role === "architecture_manager" && agent.enabled === true)) {
          setSelectedArchitectureManagerId(storedAgentId);
        }
      })
      .catch(() => { if (active) setAgentDirectory([]); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (selectedArchitectureManager?.id !== selectedArchitectureManagerId) setSelectedArchitectureManagerId(selectedArchitectureManager?.id ?? "");
  }, [selectedArchitectureManager?.id, selectedArchitectureManagerId]);

  // Loads dashboard data from the backend.
  async function loadDashboard() {
    try {
      const sprintPlans = await client.listSprints(PROJECT_ID);
      const nextDashboard = toDashboard(sprintPlans);
      setDashboard(nextDashboard);
      try { window.sessionStorage.setItem(SPRINT_CACHE_KEY, JSON.stringify(sprintPlans)); } catch { /* cache is optional */ }
      setDashboardState("ready");
    } catch {
      setDashboardState("error");
    }
  }

  useEffect(() => {
    const cached = readSprintCache();
    if (cached) {
      setDashboard(cached);
      setDashboardState("ready");
    }
    loadDashboard();
  }, []);

  useEffect(() => {
    if (!selectedArchitectureManager?.id) return undefined;
    let active = true;
    client.listConversations({ projectId: PROJECT_ID, agentId: selectedArchitectureManager.id })
      .then((payload) => {
        if (!active) return;
        const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.conversations ?? [];
        setConversations(items);
        const saved = readChatState();
        const savedId = saved?.agent_id === selectedArchitectureManager.id ? saved.conversation_id : null;
        const selected = items.find((item) => (item.id ?? item.conversation_id) === savedId) ?? items[0] ?? null;
        const conversationId = selected?.id ?? selected?.conversation_id ?? null;
        setActiveConversationId(conversationId);
        if (conversationId) {
          writeChatState(selectedArchitectureManager.id, conversationId);
          void loadConversationMessages(conversationId);
        }
      })
      .catch(() => { if (active) setConversations([]); })
      .finally(() => { if (active) setMessagesLoading(false); });
    return () => { active = false; };
  }, [client, selectedArchitectureManager?.id]);

  useEffect(() => {
    const stream = client.connectProjectStream({
      projectId: PROJECT_ID,
      onOpen: () => setWatcherState("connected"),
      onEvent: (event) => {
        if (event.event_type.startsWith("conversation.message.") || event.event_type === "conversation.agent.status_changed") {
          if (event.payload?.conversation_id !== activeConversationIdRef.current) return;
          const payload = event.payload ?? {};
          const key = event.event_type === "conversation.message.owner" || event.event_type === "conversation.message.created"
            ? `owner:${payload.message_id ?? event.event_id}`
            : `agent:${payload.correlation_id ?? payload.message_id ?? event.event_id}`;
          const timestamp = event.timestamp ?? new Date().toISOString();
          if (event.event_type === "conversation.agent.status_changed") {
            setAgentTyping(payload.status === "working");
            return;
          }
          if (event.event_type === "conversation.message.failed") {
            const code = payload.error?.code ?? "AGENT_ERROR";
            setMessages((current) => {
              if (current.some((message) => message.stream_key === `${key}:failed`)) return current;
              return [...current, { id: payload.message_id ?? event.event_id, stream_key: `${key}:failed`, text: payload.error?.message ?? "Agent request failed.", from: "system", nickname: "System", timestamp, retryable: payload.error?.retryable !== false, failedCode: code }];
            });
            setAgentTyping(false);
            return;
          }
          setMessages((current) => {
            const index = current.findIndex((message) => message.stream_key === key);
            if (event.event_type === "conversation.message.owner" || event.event_type === "conversation.message.created") {
              if (current.some((message) => message.id === payload.message_id)) return current;
              const ownerIndex = index >= 0 ? index : current.findIndex((message) => message.from === "owner" && message.correlation_id === payload.correlation_id && message.pending);
              if (ownerIndex >= 0) {
                const next = [...current];
                next[ownerIndex] = { ...next[ownerIndex], id: payload.message_id ?? next[ownerIndex].id, text: payload.text ?? next[ownerIndex].text, pending: false };
                return next;
              }
              return [...current, { id: payload.message_id ?? event.event_id, stream_key: key, text: payload.text ?? "", from: "owner", nickname: "You", timestamp }];
            }
            if (event.event_type === "conversation.message.delta") {
              const chunk = payload.chunk ?? payload.text ?? "";
              if (!chunk) return current;
              setAgentTyping(true);
              if (index < 0) return [...current, { id: payload.message_id ?? event.event_id, stream_key: key, text: chunk, from: "agent", nickname: agentDisplayName(payload.agent_id, agentDirectoryRef.current), timestamp, stream: true }];
              const next = [...current];
              next[index] = { ...next[index], text: `${next[index].text ?? ""}${chunk}`, stream: true };
              return next;
            }
            if (event.event_type === "conversation.message.received" || event.event_type === "conversation.message.completed") {
              setAgentTyping(false);
              if (index < 0) return [...current, { id: payload.message_id ?? event.event_id, stream_key: key, text: payload.text ?? "", from: "agent", nickname: agentDisplayName(payload.agent_id, agentDirectoryRef.current), timestamp }];
              const next = [...current];
              next[index] = { ...next[index], id: payload.message_id ?? next[index].id, text: payload.text ?? next[index].text, stream: false, timestamp };
              return next;
            }
            return current;
          });
          return;
        }
        setWatcherEvents((current) => applyWatcherEvent(current, event));
        const processPayload = event.payload?.agent_process ?? event.payload?.agentProcess ?? event.payload?.process ?? event.payload?.watcher?.agent_process ?? event.payload?.watcher?.agentProcess;
        if (processPayload) setAgentProcess((current) => ({ ...(current ?? {}), process: processPayload }));
        if (["ticket.created", "ticket.updated", "ticket.status_changed", "ticket.deleted", "sprint.created", "sprint.updated", "sprint.deleted"].includes(event.event_type)) {
          loadDashboard();
        }
        if (["watcher.file_indexed", "watcher.file_removed"].includes(event.event_type)) {
          setWatcherPulseId((current) => current + 1);
        }
        if (event.event_type === "stream.connected" || event.event_type === "stream.snapshot") setWatcherState("connected");
        if (event.event_type === "stream.error") setWatcherState("error");
      },
      onError: () => setWatcherState("error")
    });
    return () => stream.close();
  }, [client]);

  useEffect(() => {
    const container = chatMessagesRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Loads messages for the active conversation from the backend.
  async function loadConversationMessages(conversationId) {
    if (!conversationId) return;
    setMessagesLoading(true);
    try {
      const result = await client.getConversationMessages({ projectId: PROJECT_ID, conversationId, limit: 10, order: "desc" });
      const items = Array.isArray(result) ? result : result?.items ?? [];
      setMessages([...items].reverse().map((record, index) => {
        const content = record.content ?? {};
        const text = typeof content === "string" ? content : content.text ?? content.content ?? "";
        const isOwner = record.kind === "owner";
        return {
          id: record.id ?? `HIST-${index}`,
          stream_key: `${isOwner ? "owner" : "agent"}:${record.id ?? index}`,
          text: String(text ?? ""),
          from: isOwner ? "owner" : record.kind === "failure" ? "system" : "agent",
          nickname: isOwner ? "You" : agentDisplayName(record.agent_id, agentDirectoryRef.current),
          timestamp: record.timestamp ?? new Date().toISOString()
        };
      }));
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }

  // Handles conversation selection: binds chat to the chosen conversation.
  function handleSelectConversation(conversation) {
    const id = conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId ?? null;
    if (!id) return;
    setActiveConversationId(id);
    writeChatState(selectedArchitectureManager?.id, id);
    setMessages([]);
    setChatState("");
    setAgentTyping(false);
    void loadConversationMessages(id);
  }

  // Sends a chat message to the backend.
  async function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (sendingRef.current) return;
    if (!selectedArchitectureManager) {
      setChatState("Select an Architecture Manager before sending a message.");
      return;
    }
    sendingRef.current = true;
    let conversationId = activeConversationId ?? selectedArchitectureManager.conversation_id ?? selectedArchitectureManager.conversationId ?? ARCHITECTURE_CONVERSATION_ID;
    if (!isPersistedConversationId(conversationId)) {
      try {
        const conversation = await client.createConversation({ projectId: PROJECT_ID, agentId: selectedArchitectureManager.id, title: text.slice(0, 120) });
        conversationId = conversation.id ?? conversation.conversation_id;
        if (!isPersistedConversationId(conversationId)) throw new Error("Node returned an invalid conversation id.");
        setActiveConversationId(conversationId);
        writeChatState(selectedArchitectureManager.id, conversationId);
      } catch (error) {
        sendingRef.current = false;
        setChatState(error?.message ?? "Node could not create the conversation.");
        return;
      }
    }
    const messageId = createChatId("MSG-OWNER");
    const correlationId = createChatId("CORR-architecture-manager");
    const timestamp = new Date().toISOString();
    setDraft("");
    setChatState("");
    lastSentRef.current = { text, conversationId, messageId, correlationId };
    setMessages((current) => [...current, { id: messageId, stream_key: `owner:${messageId}`, text, from: "owner", nickname: "You", timestamp, correlation_id: correlationId, pending: true }]);
    try {
      await client.postOwnerMessage({
        projectId: PROJECT_ID,
        conversationId,
        agentId: selectedArchitectureManager.id,
        messageId,
        correlationId,
        text,
        intent: MESSAGE_INTENTS.normalChat
      });
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, pending: false, failed: true } : message));
      setChatState(error?.message ?? "Node rejected the owner message.");
    }
    sendingRef.current = false;
  }

  // Retries the last failed message.
  async function retryLastMessage() {
    const last = lastSentRef.current;
    if (!last || !selectedArchitectureManager) return;
    try {
      await client.postOwnerMessage({
        projectId: PROJECT_ID,
        conversationId: last.conversationId,
        agentId: selectedArchitectureManager.id,
        messageId: createChatId("MSG-OWNER-RETRY"),
        correlationId: createChatId("CORR-architecture-manager-RETRY"),
        text: last.text,
        intent: MESSAGE_INTENTS.normalChat
      });
    } catch (error) {
      setChatState(error?.message ?? "Node rejected the owner message.");
    }
  }

  // Handles cleanup after a ticket is deleted.
  function handleTicketDeleted(ticketId) {
    setDashboard((current) => {
      if (!current) return current;
      const next = { ...current, roadmap: { ...current.roadmap, sprints: current.roadmap.sprints.map((sprint) => ({ ...sprint, tasks: (sprint.tasks ?? []).filter((ticket) => ticket.id !== ticketId) })) } };
      try { window.sessionStorage.setItem(SPRINT_CACHE_KEY, JSON.stringify(next.roadmap.sprints.map((sprint) => ({ ...sprint, tickets: sprint.tasks })))); } catch { /* cache is optional */ }
      return next;
    });
  }

  const sprints = dashboard?.roadmap?.sprints ?? [];
  const tickets = sprints.flatMap((sprint) => sprint.tasks ?? []);

  return <div className="app-shell app-shell-control-room home-workspace-shell">
    <NodeForgeHeader title="NODEFORGE" subtitle="Supervisor Control Room" status={<><span className="live-dot" /> node online</>} actions={<Link className="history-button" href="/agents">Agents</Link>} />
    <main className="home-workspace" aria-label="NodeForge workspace">
      <section className="home-chat-panel home-panel" aria-label="Project chat">
        <div className="home-panel-heading"><div className="home-chat-heading"><div className="home-chat-title"><i aria-hidden="true" /><p className="eyebrow">PROJECT CHAT</p></div><div className="home-agent-select-row"><label className="home-agent-select-label" htmlFor="home-architecture-manager-selector">Architecture Manager</label><select className="home-agent-select" id="home-architecture-manager-selector" value={selectedArchitectureManagerId} onChange={(event) => { const agentId = event.target.value; setSelectedArchitectureManagerId(agentId); writeArchitectureManagerAgent(PROJECT_ID, agentId); }} aria-label="Architecture Manager selection"><option value="">{architectureManagers.length ? "Select an Architecture Manager" : "No enabled Architecture Manager agents available"}</option>{architectureManagers.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></div></div></div>
        <ConversationsAccordion conversations={conversations} projectId={PROJECT_ID} agentId={selectedArchitectureManager?.id} activeConversationId={activeConversationId} onNewConversation={(_title, conversation) => { const id = conversation?.id ?? conversation?.conversation_id; if (id) { setActiveConversationId(id); writeChatState(selectedArchitectureManager?.id, id); void loadConversationMessages(id); } setMessages([]); setChatState(""); }} onSelectConversation={handleSelectConversation} />
        <div className="home-chat-messages" ref={chatMessagesRef} role="log" aria-live="polite">{messagesLoading && <p className="dashboard-state">Loading messages…</p>}{!messagesLoading && messages.length === 0 && <div className="home-empty-state"><span className="home-empty-mark">N</span><p>Send a message to start working with your project agents.</p></div>}{messages.map((message) => <div className={`home-chat-message ${message.from === "owner" ? "is-owner" : "is-agent"}`} key={message.id}><div className="home-message-meta"><span>{message.nickname ?? (message.from === "owner" ? "You" : "Agent")}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div><MessageContent text={message.text} />{message.from === "system" && message.retryable !== false && <button type="button" className="history-button" onClick={retryLastMessage}>Retry</button>}</div>)}{agentTyping && <p className="dashboard-state" role="status">Agent is typing…</p>}</div>
        <form className="home-composer" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.trim()) event.currentTarget.form?.requestSubmit(); } }} placeholder="Chat or paste a ticket..." rows="2" aria-label="Chat or ticket input" /><button type="submit" aria-label="Send message" disabled={!draft.trim()}>&#8593;</button></form>{chatState && <p className={`dashboard-state ${chatState.includes("successfully") ? "success" : "error"}`} role="alert">{chatState}</p>}
      </section>
      <section className="home-sprint-panel home-panel" aria-label="Project sprints">
        <div className="home-panel-heading"><div><p className="eyebrow">PROJECT DELIVERY</p><h2>Sprints</h2></div><button className="history-button" type="button" onClick={() => setUploadOpen(true)}>Upload plan</button></div>
        {dashboardState === "loading" && <p className="dashboard-state">Loading sprint data...</p>}
        {dashboardState === "error" && <p className="dashboard-state error">Could not load sprint data.</p>}
        {dashboardState === "ready" && <div className="home-sprint-content">
          <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={loadDashboard} onTicketDeleted={handleTicketDeleted} hideHeading />
        </div>}
      </section>
      <section className="home-open-panel workspace-panel" aria-label="Workspace">
        <div className="workspace-overview"><span>WORKSPACE</span><p>{dashboard?.roadmap?.id ?? "Project workspace"}</p><small>{sprints.length ? `${sprints.length} sprint${sprints.length === 1 ? "" : "s"} connected` : "No roadmap published yet."}</small></div>
        <section className="workspace-agent-process" aria-label="Agent process">
          <div className="workspace-agent-process-heading"><div className="workspace-agent-process-status"><i aria-hidden="true" /><span>AGENT PROCESS</span></div></div>
          <div className="workspace-agent-process-body"><small>Waiting for agent process events...</small></div>
        </section>
        <section className="workspace-watcher" aria-label="Watcher">
          <div className="workspace-watcher-heading"><div className="workspace-watcher-status"><i key={watcherPulseId} className={`is-${watcherState}${watcherPulseId ? " is-pulsing" : ""}`} aria-label={`Watcher ${watcherState}`} /><span>WATCHER</span></div><AgentProcessStatus agent={agentProcess} /></div>
          <div className="workspace-watcher-process" aria-label="Watcher indexed files">
            {watcherEvents.length === 0 && <small>{watcherState === "error" ? "Stream unavailable." : "Waiting for watcher events..."}</small>}
            {watcherEvents.map((event) => <div className="workspace-watcher-event" key={event.event_id}>{event.payload.activity.map((line) => <span key={line}>{line}</span>)}</div>)}
          </div>
        </section>
      </section>
    </main>
    {uploadOpen && <UploadSprintPlanDialog client={client} onClose={() => setUploadOpen(false)} onUploaded={() => { setUploadOpen(false); loadDashboard(); }} />}
  </div>;
}
