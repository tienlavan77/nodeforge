"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { NodeForgeHeader } from "../components/NodeForgeHeader.jsx";
import { MessageContent, SprintPlanDashboard, UploadSprintPlanDialog } from "../components/NodeForgePanels.jsx";
import { createNodeClient, normalizeTicketInput } from "../lib/node-client.js";

const PROJECT_ID = "PROJECT-NODEFORGE";
const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";
const SPRINT_CACHE_KEY = `nodeforge:sprints:${PROJECT_ID}`;

function toDashboard(sprintPlans) {
  const plans = Array.isArray(sprintPlans) ? sprintPlans : sprintPlans?.items ?? sprintPlans?.sprints ?? [];
  return { project_id: PROJECT_ID, roadmap: { id: plans[0]?.roadmap_id ?? `ROADMAP-${PROJECT_ID}`, version: plans.at(-1)?.id ?? "latest", sprints: plans.map((sprint, index) => ({ id: sprint.id, objective: sprint.objective, order: index + 1, status: sprint.status ?? "planned", tasks: (sprint.tickets ?? []).map((ticket) => ({ ...ticket, status: ticket.status ?? "planned", progress: ticket.status === "done" ? 100 : ticket.status === "running" || ticket.status === "reviewing" ? 50 : 0 })) })) } };
}

function readSprintCache() {
  if (typeof window === "undefined") return null;
  try { return toDashboard(JSON.parse(window.sessionStorage.getItem(SPRINT_CACHE_KEY) ?? "null")); } catch { return null; }
}

function normalizeWatcherEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => Array.isArray(event?.payload?.activity) && event.payload.activity.length > 0)
    .sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
    .slice(-4);
}

function applyWatcherEvent(current, event) {
  if (event?.event_type === "stream.snapshot") return normalizeWatcherEvents(event.payload?.watcher?.recent_events);
  if (!["watcher.file_indexed", "watcher.file_removed"].includes(event?.event_type) || !Array.isArray(event.payload?.activity)) return current;
  return normalizeWatcherEvents([...current, event]);
}

function displayMessageTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isOwnerConversationMessage(message) {
  const senderRole = message?.sender?.role ?? message?.from?.role ?? message?.metadata?.sender_role;
  const senderId = String(message?.sender?.id ?? message?.from?.id ?? message?.sender_id ?? "").toLowerCase();
  return senderRole === "project_owner" || message?.message_type === "owner.message" || senderId === "project-owner" || senderId === "owner" || senderId.startsWith("owner-");
}

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

  const architectureManagers = useMemo(() => agentDirectory
    .filter((agent) => agent?.role === "architecture_manager" && agent?.enabled === true)
    .map((agent) => ({
      ...agent,
      id: agent.agent_id ?? agent.id,
      label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id
    }))
    .filter((agent) => agent.id), [agentDirectory]);
  const selectedArchitectureManager = architectureManagers.find((agent) => agent.id === selectedArchitectureManagerId) ?? null;

  useEffect(() => {
    let active = true;
    client.getAgents()
      .then((payload) => {
        if (!active) return;
        const agents = Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? [];
        setAgentDirectory(agents);
      })
      .catch(() => { if (active) setAgentDirectory([]); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (selectedArchitectureManager?.id !== selectedArchitectureManagerId) setSelectedArchitectureManagerId(selectedArchitectureManager?.id ?? "");
  }, [selectedArchitectureManager?.id, selectedArchitectureManagerId]);

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
    const stream = client.connectProjectStream({
      projectId: PROJECT_ID,
      onOpen: () => setWatcherState("connected"),
      onEvent: (event) => {
        setWatcherEvents((current) => applyWatcherEvent(current, event));
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
    if (!selectedArchitectureManager) return undefined;
    const conversationId = selectedArchitectureManager.conversation_id ?? selectedArchitectureManager.conversationId ?? ARCHITECTURE_CONVERSATION_ID;
    const stream = client.connectConversationStream({
      projectId: PROJECT_ID,
      conversationId,
      onMessage: (message) => {
        const text = message?.payload?.text ?? message?.payload?.content ?? message?.text ?? message?.content;
        if (typeof text !== "string" || !text.trim()) return;
        const id = message.message_id ?? message.id ?? `agent-${Date.now()}`;
        const ownerMessage = isOwnerConversationMessage(message);
        const senderName = message?.sender?.name
          ?? message?.sender?.nickname
          ?? message?.sender?.label
          ?? message?.payload?.sender_name
          ?? message?.payload?.agent_name
          ?? message?.metadata?.agent_name;
        setMessages((current) => current.some((item) => item.id === id) ? current : [...current, {
          id,
          text,
          from: ownerMessage ? "owner" : "agent",
          nickname: ownerMessage ? "You" : (senderName || selectedArchitectureManager.label),
          timestamp: message.timestamp ?? new Date().toISOString()
        }]);
      }
    });
    return () => stream.close();
  }, [client, selectedArchitectureManager]);

  useEffect(() => {
    const container = chatMessagesRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const normalized = normalizeTicketInput(text);
    const ticket = normalized.ticket;

    const sprintId = latestSprint?.id;
    if (!sprintId) {
      setChatState("No sprint is available for this ticket.");
      return;
    }

    if (ticket) {
      setDraft("");
      setChatState("");
      try {
        await client.createTicket(PROJECT_ID, ticket, sprintId);
        setChatState("Ticket created successfully.");
        await loadDashboard();
      } catch (error) {
        setChatState(error?.message ?? "Node could not create the ticket.");
      }
      return;
    }

    setDraft("");
    setChatState("");
    try {
      await client.createTicket(PROJECT_ID, text, sprintId);
      setChatState("Ticket created successfully.");
      await loadDashboard();
    } catch (error) {
      setChatState(error?.message ?? "Node rejected the owner message.");
    }
  }

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
  const completed = tickets.filter((ticket) => ticket.status === "done").length;
  const latestSprint = sprints.at(-1);

  return <div className="app-shell app-shell-control-room home-workspace-shell">
    <NodeForgeHeader title="NODEFORGE" subtitle="Supervisor Control Room" status={<><span className="live-dot" /> node online</>} actions={<Link className="history-button" href="/agents">Agents</Link>} />
    <main className="home-workspace" aria-label="NodeForge workspace">
      <section className="home-chat-panel home-panel" aria-label="Project chat">
        <div className="home-panel-heading"><div className="home-chat-heading"><div className="home-chat-title"><i aria-hidden="true" /><p className="eyebrow">PROJECT CHAT</p></div><div className="home-agent-select-row"><label className="home-agent-select-label" htmlFor="home-architecture-manager-selector">Architecture Manager</label><select className="home-agent-select" id="home-architecture-manager-selector" value={selectedArchitectureManagerId} onChange={(event) => setSelectedArchitectureManagerId(event.target.value)} aria-label="Architecture Manager selection"><option value="">{architectureManagers.length ? "Select an Architecture Manager" : "No enabled Architecture Manager agents available"}</option>{architectureManagers.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></div></div></div>
        <div className="home-chat-messages" ref={chatMessagesRef} role="log" aria-live="polite">{messages.length === 0 && <div className="home-empty-state"><span className="home-empty-mark">N</span><p>Send a message to start working with your project agents.</p></div>}{messages.map((message) => <div className={`home-chat-message ${message.from === "owner" ? "is-owner" : "is-agent"}`} key={message.id}><div className="home-message-meta"><span>{message.nickname ?? (message.from === "owner" ? "You" : "Agent")}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div><MessageContent text={message.text} /></div>)}</div>
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
          <div className="workspace-watcher-heading"><div className="workspace-watcher-status"><i key={watcherPulseId} className={`is-${watcherState}${watcherPulseId ? " is-pulsing" : ""}`} aria-label={`Watcher ${watcherState}`} /><span>WATCHER</span></div></div>
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
