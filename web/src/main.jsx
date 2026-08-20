import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createNodeClient } from "./services/node-client.js";
import "./styles.css";

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet", status: "Reviewing roadmap", messages: [{ from: "agent", text: "Architecture baseline is aligned with the current project constraints.", time: "09:41" }, { from: "agent", text: "I have queued the next decision set for owner review.", time: "09:44" }] },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan", status: "Planning Sprint 13", messages: [{ from: "agent", text: "Sprint 13 has 8 tickets ready for prioritization.", time: "09:38" }, { from: "owner", text: "Keep the UI work focused on the Node control surface.", time: "09:39" }] },
  { id: "builder", label: "Builder", short: "BU", tone: "amber", status: "Implementing NF-135", messages: [{ from: "agent", text: "Web Control Shell scaffold is in progress.", time: "09:35" }, { from: "agent", text: "No backend integrations have been changed.", time: "09:40" }] },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green", status: "Waiting for changes", messages: [{ from: "agent", text: "I am waiting for the Builder handoff before review.", time: "09:31" }] }
];
const PROJECT_ID = "PROJECT-NODEFORGE";
const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";

function App() {
  const client = useMemo(() => createNodeClient(), []);
  const [activeAgent, setActiveAgent] = useState("architecture-manager");
  const [drafts, setDrafts] = useState({});
  const [messages, setMessages] = useState(() => Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.messages])));
  const [workspace, setWorkspace] = useState(null);
  const [workspaceStatus, setWorkspaceStatus] = useState("READY");
  const lastMessageId = useRef();
  const active = AGENTS.find((agent) => agent.id === activeAgent);
  const loadWorkspace = useCallback(async () => {
    try {
      const data = await client.getArchitectureWorkspace(PROJECT_ID);
      setWorkspace(data);
      setWorkspaceStatus(data.agent.status);
    } catch {
      setWorkspaceStatus("FAILED");
    }
  }, [client]);

  useEffect(() => {
    loadWorkspace();
    const stream = client.connectConversationStream({
      projectId: PROJECT_ID,
      conversationId: ARCHITECTURE_CONVERSATION_ID,
      onMessage: (message) => {
        lastMessageId.current = message.message_id;
        if (message.payload?.agent_status) setWorkspaceStatus(message.payload.agent_status);
        setMessages((current) => ({
          ...current,
          "architecture-manager": [...current["architecture-manager"], toDisplayMessage(message)]
        }));
        if (message.message_type === "architecture.message.received") loadWorkspace();
      }
    });
    return () => stream.close();
  }, [client, loadWorkspace]);

  async function send(agentId) {
    const text = drafts[agentId]?.trim();
    if (!text) return;
    setDrafts((current) => ({ ...current, [agentId]: "" }));
    if (agentId === "architecture-manager") {
      try {
        await client.postOwnerMessage({
          projectId: PROJECT_ID,
          conversationId: ARCHITECTURE_CONVERSATION_ID,
          messageId: `MSG-OWNER-${Date.now()}`,
          correlationId: `CORR-ARCH-${Date.now()}`,
          text
        });
      } catch {
        setMessages((current) => ({ ...current, [agentId]: [...current[agentId], { from: "system", text: "Node is unavailable. Your message was not sent.", time: "now" }] }));
      }
      return;
    }
    const sent = client.sendOwnerMessage(agentId, text);
    setMessages((current) => ({ ...current, [agentId]: [...current[agentId], { from: "owner", text: sent.text, time: "now" }] }));
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><div><div className="brand-name">NODE CONTROL ROOM</div><div className="brand-sub">Human governance surface</div></div></div>
      <div className="topbar-meta"><span className="connection"><span className="live-dot" /> NODE ONLINE</span><span className="divider" /><span className="project-label">PROJECT <strong>NODEFORGE</strong></span><button className="icon-button" title="Open settings" aria-label="Open settings">&#9881;</button></div>
    </header>
    <main className="workspace">
      <section className="architecture-panel panel" aria-label="Architecture Manager conversation">
        <ArchitecturePanel agent={{ ...AGENTS[0], status: workspaceStatus }} workspace={workspace} messages={messages[AGENTS[0].id]} draft={drafts[AGENTS[0].id] ?? ""} onDraft={(value) => setDrafts((current) => ({ ...current, [AGENTS[0].id]: value }))} onSend={() => send(AGENTS[0].id)} onActivate={() => setActiveAgent(AGENTS[0].id)} active={activeAgent === AGENTS[0].id} />
      </section>
      <section className="agent-stack">
        {AGENTS.slice(1).map((agent) => <AgentPanel key={agent.id} agent={agent} messages={messages[agent.id]} draft={drafts[agent.id] ?? ""} onDraft={(value) => setDrafts((current) => ({ ...current, [agent.id]: value }))} onSend={() => send(agent.id)} onActivate={() => setActiveAgent(agent.id)} active={activeAgent === agent.id} />)}
      </section>
    </main>
    <footer className="statusbar"><div><span className="status-key">ACTIVE CHANNEL</span><span className="status-value">{active.label}</span></div><div className="event-status"><span className="pulse" /> Event stream ready <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
  </div>;
}

function toDisplayMessage(message) {
  const isOwner = message.sender?.role === "project_owner";
  const text = message.payload?.text
    ?? (message.message_type === "architecture.working" ? "Architecture Manager is working…" : message.message_type === "architecture.message.received" ? "Architecture plan recorded in Node." : message.message_type);
  return { id: message.message_id, from: isOwner ? "owner" : message.message_type.includes("error") ? "system" : "agent", text, time: new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
}

function ArchitecturePanel({ agent, workspace, messages, draft, onDraft, onSend, onActivate, active }) {
  const conversationRef = useRef(null);
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const element = conversationRef.current;
    if (element && wasAtBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  return <article className={`agent-panel architecture-workspace ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} />
    <div className="architecture-columns">
      <div className="architecture-conversation conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label="Architecture Manager messages">
        <div className="date-rule"><span>Conversation</span></div>
        {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      </div>
      <ArchitectureArtifacts workspace={workspace} />
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Message Architecture Manager..." aria-label="Message Architecture Manager" /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}

function ArchitectureArtifacts({ workspace }) {
  if (!workspace) return <div className="architecture-artifacts"><div className="workspace-loading">Loading Architecture Workspace from Node…</div></div>;
  const plan = workspace.architecture_plan;
  return <aside className="architecture-artifacts" aria-label="Architecture Workspace data">
    <WorkspaceSection title="Architecture Plan" items={plan.architecture} empty="No architecture plan published yet." />
    <WorkspaceSection title="Architecture Decisions" items={workspace.decisions} empty="No decisions published yet." />
    <WorkspaceSection title="Standards" items={workspace.standards} empty="No standards published yet." />
    <WorkspaceSection title="Constraints" items={workspace.constraints} empty="No constraints published yet." />
    <section className="workspace-section"><h3>Current Roadmap</h3>{workspace.roadmap ? <div className="roadmap-card"><strong>{workspace.roadmap.id}</strong><span>Version {workspace.roadmap.version}</span></div> : <p className="workspace-empty">No roadmap published yet.</p>}</section>
    <WorkspaceSection title="Sprint Breakdown" items={workspace.sprint_breakdown} empty="No sprint breakdown published yet." />
  </aside>;
}

function WorkspaceSection({ title, items, empty }) {
  return <section className="workspace-section"><h3>{title}</h3>{items.length ? <div className="workspace-items">{items.map((item) => <div className="workspace-card" key={item.id}><strong>{item.title ?? item.id}</strong>{item.decision && <p>{item.decision}</p>}{item.objective && <p>{item.objective}</p>}{item.status && <span>{item.status}</span>}{item.tickets && <span>{item.tickets.length} ticket{item.tickets.length === 1 ? "" : "s"}</span>}</div>)}</div> : <p className="workspace-empty">{empty}</p>}</section>;
}

function PanelHeader({ agent }) {
  return <header className="agent-header"><div className={`agent-avatar ${agent.tone}`}>{agent.short}</div><div className="agent-heading"><h2>{agent.label}</h2><div className="agent-status"><span className="status-dot" /> {agent.status}</div></div><button className="panel-menu" title="Panel actions" aria-label={`${agent.label} panel actions`}>&#8942;</button></header>;
}

function Message({ message }) {
  return <div className={`message-row ${message.from === "owner" ? "owner" : "agent"}`}><div className="message-bubble"><p>{message.text}</p><time>{message.time}</time></div></div>;
}

function AgentPanel({ agent, messages, draft, onDraft, onSend, onActivate, active, expanded }) {
  const conversationRef = useRef(null);
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const element = conversationRef.current;
    if (!element) return;
    if (wasAtBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  return <article className={`agent-panel panel ${expanded ? "expanded" : ""} ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} />
    <div className="conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label={`${agent.label} messages`}>
      <div className="date-rule"><span>Today</span></div>
      {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      <div className="typing-line"><span className="typing-dots"><i /><i /><i /></span> Node is listening</div>
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder={`Message ${agent.label}...`} aria-label={`Message ${agent.label}`} /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}

createRoot(document.getElementById("root")).render(<App />);
