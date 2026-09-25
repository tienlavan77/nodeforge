"use client";
// HomePage — main workspace with dashboard and real-time updates.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { NodeForgeHeader } from "../components/NodeForgeHeader.jsx";
import { AgentProcessStatus, MessageContent, SprintPlanDashboard, UploadSprintPlanDialog } from "../components/NodeForgePanels.jsx";
import { ConversationsAccordion } from "../components/ConversationsAccordion.jsx";
import { createNodeClient, MESSAGE_INTENTS } from "../lib/node-client.js";
import { architectureManagerSelection, writeArchitectureManagerAgent } from "../../src/architecture-manager-selection.js";
import { PROJECT_ID, ARCHITECTURE_CONVERSATION_ID, SPRINT_CACHE_KEY, CHAT_STATE_KEY } from "../lib/home-page-constants.js";
import { toDashboard, readSprintCache } from "../lib/home-page-dashboard.js";
import { readChatState, writeChatState } from "../lib/home-page-conversation-state.js";
import { displayMessageTime, agentDisplayName } from "../lib/home-page-watcher-events.js";
import { useProjectEventStream } from "../lib/home-page-event-stream.js";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";

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
        const saved = readChatState(CHAT_STATE_KEY);
        const savedId = saved?.agent_id === selectedArchitectureManager.id ? saved.conversation_id : null;
        const selected = items.find((item) => (item.id ?? item.conversation_id) === savedId) ?? items[0] ?? null;
        const conversationId = selected?.id ?? selected?.conversation_id ?? null;
        setActiveConversationId(conversationId);
        if (conversationId) {
          writeChatState(CHAT_STATE_KEY, selectedArchitectureManager.id, conversationId);
          void loadConversationMessages(conversationId);
        }
      })
      .catch(() => { if (active) setConversations([]); })
      .finally(() => { if (active) setMessagesLoading(false); });
    return () => { active = false; };
  }, [client, selectedArchitectureManager?.id]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
    setMessages, setAgentTyping, setWatcherEvents, setWatcherPulseId, setWatcherState,
    setAgentProcess, loadDashboard, agentDisplayName
  });

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
    writeChatState(CHAT_STATE_KEY, selectedArchitectureManager?.id, id);
    setMessages([]);
    setChatState("");
    setAgentTyping(false);
    void loadConversationMessages(id);
  }

  const { sendMessage, retryLastMessage } = createHomeMessageHandlers({
    client, projectId: PROJECT_ID, architectureConversationId: ARCHITECTURE_CONVERSATION_ID, chatStateKey: CHAT_STATE_KEY,
    draft, setDraft, selectedArchitectureManager, activeConversationId, setActiveConversationId,
    setChatState, setMessages, sendingRef, lastSentRef, writeChatState, messageIntent: MESSAGE_INTENTS.normalChat
  });

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
        <ConversationsAccordion conversations={conversations} projectId={PROJECT_ID} agentId={selectedArchitectureManager?.id} activeConversationId={activeConversationId} onNewConversation={(_title, conversation) => { const id = conversation?.id ?? conversation?.conversation_id; if (id) { setActiveConversationId(id); writeChatState(CHAT_STATE_KEY, selectedArchitectureManager?.id, id); void loadConversationMessages(id); } setMessages([]); setChatState(""); }} onSelectConversation={handleSelectConversation} />
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
