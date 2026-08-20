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
  const [dashboard, setDashboard] = useState(null);
  const [dashboardState, setDashboardState] = useState("loading");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState(null);
  const lastMessageId = useRef();
  const pendingDeltas = useRef([]);
  const deltaFrame = useRef();
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
  const loadDashboard = useCallback(async () => {
    setDashboardState("loading");
    try {
      setDashboard(await client.getProjectDashboard(PROJECT_ID));
      setDashboardState("ready");
    } catch {
      setDashboardState("error");
    }
  }, [client]);

  useEffect(() => {
    loadWorkspace();
    loadDashboard();
    const stream = client.connectConversationStream({
      projectId: PROJECT_ID,
      conversationId: ARCHITECTURE_CONVERSATION_ID,
      onMessage: (message) => {
        lastMessageId.current = message.message_id;
        if (message.message_type === "architecture.working") setWorkspaceStatus("WORKING");
        if (["architecture.message.received", "architecture.error"].includes(message.message_type)) setWorkspaceStatus(message.payload?.agent_status ?? (message.message_type === "architecture.error" ? "FAILED" : "COMPLETED"));
        if (message.message_type === "architecture.message.delta") {
          pendingDeltas.current.push(message);
          if (!deltaFrame.current) deltaFrame.current = requestAnimationFrame(() => {
            const deltas = pendingDeltas.current.splice(0); deltaFrame.current = undefined;
            setMessages((current) => ({ ...current, "architecture-manager": deltas.reduce((items, delta) => mergeStreamMessage(items, delta), current["architecture-manager"]) }));
          });
        } else {
          if (deltaFrame.current) { cancelAnimationFrame(deltaFrame.current); deltaFrame.current = undefined; }
          const queued = pendingDeltas.current.splice(0);
          setMessages((current) => ({ ...current, "architecture-manager": [...queued, message].reduce((items, item) => mergeStreamMessage(items, item), current["architecture-manager"]) }));
        }
        if (message.message_type === "architecture.message.received") loadWorkspace();
      }
    });
    return () => { if (deltaFrame.current) cancelAnimationFrame(deltaFrame.current); stream.close(); };
  }, [client, loadWorkspace, loadDashboard]);

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
      <div className="topbar-meta"><span className="connection"><span className="live-dot" /> NODE ONLINE</span><span className="divider" /><span className="project-label">PROJECT <strong>NODEFORGE</strong></span><button className="history-button" onClick={() => setHistoryOpen(true)}>History</button><button className="icon-button" title="Open settings" aria-label="Open settings">&#9881;</button></div>
    </header>
    <main className="workspace">
      <section className="architecture-panel panel" aria-label="Architecture Manager conversation">
        <ArchitecturePanel onSettings={() => setSettingsAgent(AGENTS[0])} client={client} onWorkspaceChanged={loadWorkspace} agent={{ ...AGENTS[0], status: workspaceStatus }} workspace={workspace} messages={messages[AGENTS[0].id]} draft={drafts[AGENTS[0].id] ?? ""} onDraft={(value) => setDrafts((current) => ({ ...current, [AGENTS[0].id]: value }))} onSend={() => send(AGENTS[0].id)} onActivate={() => setActiveAgent(AGENTS[0].id)} active={activeAgent === AGENTS[0].id} />
      </section>
      <section className="agent-stack">
        <ProjectDashboardPanel onSettings={() => setSettingsAgent(AGENTS[1])} agent={AGENTS[1]} dashboard={dashboard} state={dashboardState} onActivate={() => setActiveAgent(AGENTS[1].id)} active={activeAgent === AGENTS[1].id} />
        {AGENTS.slice(2).map((agent) => <AgentPanel onSettings={() => setSettingsAgent(agent)} key={agent.id} agent={agent} messages={messages[agent.id]} draft={drafts[agent.id] ?? ""} onDraft={(value) => setDrafts((current) => ({ ...current, [agent.id]: value }))} onSend={() => send(agent.id)} onActivate={() => setActiveAgent(agent.id)} active={activeAgent === agent.id} />)}
      </section>
    </main>
    <footer className="statusbar"><div><span className="status-key">ACTIVE CHANNEL</span><span className="status-value">{active.label}</span></div><div className="event-status"><span className="pulse" /> Event stream ready <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
    {historyOpen && <HistoryOverlay client={client} onClose={() => setHistoryOpen(false)} />}
    {settingsAgent && <AgentSettingsOverlay client={client} agent={settingsAgent} onClose={() => setSettingsAgent(null)} />}
  </div>;
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
  const [profile, setProfile] = useState(null); const [url, setUrl] = useState(""); const [key, setKey] = useState(""); const [enabled, setEnabled] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { client.getAgentSettings().then((items) => { const item = items.find(({ agent_id: id }) => id === agent.id); if (item) { setProfile(item); setUrl(item.gateway_url); setEnabled(item.enabled); } }).catch((error) => setMessage(`Error: ${error.message}`)); }, [agent.id, client]);
  async function save() { try { const item = await client.saveAgentSettings(agent.id, { agent_name: profile?.agent_name ?? agent.label, gateway_url: url, enabled, ...(key ? { api_key: key } : {}) }); setProfile(item); setKey(""); setMessage("Saved. API key remains masked in Node."); } catch (error) { setMessage(`Error: ${error.message}`); } }
  async function testConnection() { try { const result = await client.testAgentConnection(agent.id); setMessage(`Connected: ${result.status}`); } catch (error) { setMessage(`Failed: ${error.message}`); } }
  return <div className="settings-overlay" role="dialog" aria-modal="true"><section className="settings-modal"><header><h2>{agent.label} Settings</h2><button onClick={onClose} aria-label="Close Agent Settings">&#215;</button></header><label>Gateway URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label><label>API Key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="********" autoComplete="new-password" /></label><label className="settings-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label><div className="settings-actions"><button onClick={save}>Save Profile</button><button onClick={testConnection}>Test Connection</button></div>{message && <p aria-live="polite">{message}</p>}</section></div>;
}

function toDisplayMessage(message) {
  const isOwner = message.sender?.role === "project_owner";
  const text = message.payload?.text
    ?? (message.message_type === "architecture.working" ? "Architecture Manager is working…" : message.message_type === "architecture.message.received" ? "Architecture plan recorded in Node." : message.message_type);
  return { id: message.message_id, correlation_id: message.correlation_id, message_type: message.message_type, from: isOwner ? "owner" : message.message_type.includes("error") ? "system" : "agent", text, time: new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
}

function mergeStreamMessage(messages, message) {
  if (messages.some((item) => item.id === message.message_id)) return messages;
  if (message.message_type === "architecture.working") return messages;
  const isDelta = message.message_type === "architecture.message.delta";
  const isCompletion = message.message_type === "architecture.message.received";
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
    <div className="architecture-columns">
      <div className="architecture-conversation conversation natural-conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label="Architecture Manager messages">
        <div className="date-rule"><span>Conversation</span></div>
        {agent.status === "WORKING" && <div className="working-status" role="status">Architecture Manager is working…</div>}
        {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      </div>
      <ArchitectureArtifacts client={client} onWorkspaceChanged={onWorkspaceChanged} workspace={workspace} />
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onInput={(event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} rows="2" placeholder="Message Architecture Manager..." aria-label="Message Architecture Manager" /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}

function ArchitectureArtifacts({ client, onWorkspaceChanged, workspace }) {
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
      {state === "ready" && <DashboardData dashboard={dashboard} />}
    </div>
  </article>;
}

function DashboardData({ dashboard }) {
  if (!dashboard?.roadmap || !dashboard.current_sprint) return <p className="dashboard-state">No roadmap or current sprint has been published yet.</p>;
  const sprint = dashboard.current_sprint;
  return <>
    <div className="dashboard-overview"><span>ROADMAP <strong>{dashboard.roadmap.id}</strong></span><span>v{dashboard.roadmap.version}</span><span>{sprint.status.toUpperCase()}</span></div>
    <section className="dashboard-section"><h3>{sprint.id}</h3><p>{sprint.objective}</p><small>{sprint.completed_ticket_count}/{sprint.ticket_count} tickets completed</small></section>
    <section className="dashboard-section"><h3>Sprint Backlog</h3>{dashboard.backlog.length ? <div className="dashboard-tickets">{dashboard.backlog.map((ticket) => <article className="dashboard-ticket" key={ticket.id}><div><strong>{ticket.id}</strong><span className="priority">{ticket.priority}</span></div><p>{ticket.title}</p><small>{ticket.status} · {ticket.progress}%</small>{ticket.provenance && <small className="provenance">{ticket.provenance.architecture_decision_ids.join(", ")} → {ticket.provenance.roadmap_id} → {ticket.provenance.sprint_id}</small>}</article>)}</div> : <p className="dashboard-state">No tickets in the current sprint.</p>}</section>
    <section className="dashboard-section roadmap-list"><h3>Roadmap Sprints</h3>{dashboard.roadmap.sprints.map((item) => <div key={item.id}><span>{item.order}. {item.id}</span><small>{item.status}</small></div>)}</section>
  </>;
}

function WorkspaceSection({ title, items, empty }) {
  return <section className="workspace-section"><h3>{title}</h3>{items.length ? <div className="workspace-items">{items.map((item) => <div className="workspace-card" key={item.id}><strong>{item.title ?? item.id}</strong>{item.decision && <p>{item.decision}</p>}{item.objective && <p>{item.objective}</p>}{item.status && <span>{item.status}</span>}{item.tickets && <span>{item.tickets.length} ticket{item.tickets.length === 1 ? "" : "s"}</span>}</div>)}</div> : <p className="workspace-empty">{empty}</p>}</section>;
}

function PanelHeader({ agent, onSettings }) {
  return <header className="agent-header"><div className={`agent-avatar ${agent.tone}`}>{agent.short}</div><div className="agent-heading"><h2>{agent.label}</h2><div className="agent-status"><span className="status-dot" /> {agent.status}</div></div><button className="panel-menu" onClick={onSettings} title="Agent Settings" aria-label={`${agent.label} Agent Settings`}>&#9881;</button></header>;
}

function Message({ message }) {
  return <div className={`message-row natural-message ${message.from === "owner" ? "owner" : "agent"}`}><p>{message.text}</p><time>{message.time}</time></div>;
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
