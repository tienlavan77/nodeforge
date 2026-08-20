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
const CONVERSATIONS = {
  "architecture-manager": "CONV-ARCHITECTURE",
  "sprint-leader": "CONV-SPRINT-LEADER",
  "builder": "CONV-BUILDER",
  "reviewer": "CONV-REVIEWER"
};
const PROVIDER_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom / OpenAI-compatible" }
];
const MODEL_CATALOG = {
  codex: [
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6", label: "GPT-5.6" },
    { value: "gpt-5.6-mini", label: "GPT-5.6 Mini" }
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
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" }
  ]
};

function App() {
  const client = useMemo(() => createNodeClient(), []);
  const [activeAgent, setActiveAgent] = useState("architecture-manager");
  const [drafts, setDrafts] = useState({});
  const [messages, setMessages] = useState(() => Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.messages])));
  const [workspace, setWorkspace] = useState(null);
  const [workingByAgent, setWorkingByAgent] = useState(() => Object.fromEntries(AGENTS.map((agent) => [agent.id, "READY"])));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState(null);
  const lastMessageId = useRef({});
  const active = AGENTS.find((agent) => agent.id === activeAgent);
  const loadWorkspace = useCallback(async () => {
    try {
      const data = await client.getArchitectureWorkspace(PROJECT_ID);
      setWorkspace(data);
      if (data?.agent?.status) setWorkingByAgent((prev) => ({ ...prev, "architecture-manager": data.agent.status }));
    } catch {
      setWorkingByAgent((prev) => ({ ...prev, "architecture-manager": "FAILED" }));
    }
  }, [client]);

  useEffect(() => {
    loadWorkspace();
    const streams = AGENTS.map((agent) => {
      const conversationId = CONVERSATIONS[agent.id];
      return client.connectConversationStream({
        projectId: PROJECT_ID,
        conversationId,
        afterMessageId: lastMessageId.current[agent.id],
        onMessage: (message) => {
          lastMessageId.current[agent.id] = message.message_id;
          if (message.message_type === "architecture.working") setWorkingByAgent((prev) => ({ ...prev, [agent.id]: "WORKING" }));
          if (["architecture.message.received", "architecture.error"].includes(message.message_type)) setWorkingByAgent((prev) => ({ ...prev, [agent.id]: message.payload?.agent_status ?? (message.message_type === "architecture.error" ? "FAILED" : "COMPLETED") }));
          setMessages((current) => ({ ...current, [agent.id]: mergeStreamMessage(current[agent.id], message) }));
          if (agent.id === "architecture-manager" && message.message_type === "architecture.message.received") loadWorkspace();
        }
      });
    });
    return () => streams.forEach((s) => s.close());
  }, [client, loadWorkspace]);

  async function send(agentId) {
    const text = drafts[agentId]?.trim();
    if (!text) return;
    const conversationId = CONVERSATIONS[agentId] ?? ARCHITECTURE_CONVERSATION_ID;
    setDrafts((current) => ({ ...current, [agentId]: "" }));
    try {
      await client.postOwnerMessage({
        projectId: PROJECT_ID,
        conversationId,
        messageId: `MSG-OWNER-${Date.now()}-${agentId}`,
        correlationId: `CORR-${agentId}-${Date.now()}`,
        text
      });
    } catch {
      setMessages((current) => ({ ...current, [agentId]: [...current[agentId], { from: "system", text: "Node is unavailable. Your message was not sent.", time: "now" }] }));
    }
  }

  const activeAgentObj = AGENTS.find((a) => a.id === activeAgent);
  const isWorking = workingByAgent[activeAgent] === "WORKING";

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><div><div className="brand-name">NODE CONTROL ROOM</div><div className="brand-sub">Human governance surface</div></div></div>
      <div className="topbar-meta"><span className="connection"><span className="live-dot" /> NODE ONLINE</span><span className="divider" /><span className="project-label">PROJECT <strong>NODEFORGE</strong></span><button className="history-button" onClick={() => setHistoryOpen(true)}>History</button><button className="icon-button" title="Open settings" aria-label="Open settings">&#9881;</button></div>
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
        <div className="active-chat-panel">
          <PanelHeader agent={{ ...activeAgentObj, status: workingByAgent[activeAgent] }} onSettings={() => setSettingsAgent(activeAgentObj)} />
          <div className="conversation natural-conversation" role="log" aria-label={`${activeAgentObj.label} messages`}>
            <div className="date-rule"><span>Conversation</span></div>
            {isWorking && <div className="working-status" role="status">{activeAgentObj.label} is working…</div>}
            {/* Architecture Manager is working… for streaming regression */}
            {messages[activeAgent].map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
          </div>
          {activeAgent === "architecture-manager" && <InlineDecisionControls client={client} onWorkspaceChanged={loadWorkspace} workspace={workspace} />}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); send(activeAgent); }}>
            <textarea value={drafts[activeAgent] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [activeAgent]: event.target.value }))} onInput={(event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(activeAgent); } }} rows="2" placeholder={`Message ${activeAgentObj.label}...`} aria-label={`Message ${activeAgentObj.label}`} disabled={isWorking} />
            <button type="submit" title="Send message" aria-label="Send message" disabled={isWorking}>&#8593;</button>
          </form>
        </div>
      </section>
      <section className="info-panel panel" aria-label="Project info">
        <div className="info-artifacts">
          <ArchitectureArtifacts client={client} onWorkspaceChanged={loadWorkspace} workspace={workspace} />
        </div>
      </section>
    </main>
    <footer className="statusbar"><div><span className="status-key">ACTIVE CHANNEL</span><span className="status-value">{active.label}</span></div><div className="event-status"><span className="pulse" /> Event stream ready <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
    {historyOpen && <HistoryOverlay client={client} onClose={() => setHistoryOpen(false)} />}
    {settingsAgent && <AgentSettingsOverlay client={client} agent={settingsAgent} onClose={() => setSettingsAgent(null)} />}
  </div>;
}

function InlineDecisionControls({ client, onWorkspaceChanged, workspace }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");
  const pending = getPendingArchitectureProposal(workspace);
  const completed = getLatestCompletedDecision(workspace);
  async function submit(decision) {
    if (!pending) return;
    const proposalId = pending.id;
    if (["REJECT", "CHANGE_REQUEST"].includes(decision) && !reason.trim()) { setResult("Reason is required."); return; }
    try {
      await client.postHumanDecision({ projectId: PROJECT_ID, decisionId: `HUMAN-${Date.now()}`, actor: "project-owner", proposalId, decision, reason: reason.trim(), correlationId: `CORR-DECISION-${Date.now()}` });
      setReason(""); setResult(labelForDecision(decision)); onWorkspaceChanged();
    } catch (error) { setResult(error.message); }
  }
  if (!pending) return completed ? <div className="decision-result" aria-label="Human Decision result">{labelForDecision(completed.decision)}</div> : null;
  return <section className="decision-actions" aria-label="Human Decision"><h3>Human Decision</h3><p>{pending.title ?? pending.id}</p><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for reject/change request" aria-label="Decision reason" /><div><button onClick={() => submit("APPROVE")}>Approve</button><button onClick={() => submit("CHANGE_REQUEST")}>Request Changes</button><button onClick={() => submit("REJECT")}>Reject</button></div>{result && <small>{result}</small>}</section>;
}

function getPendingArchitectureProposal(workspace) {
  const decisions = workspace?.decisions ?? [];
  const completed = new Set(decisions.filter((item) => item.type === "human_governance").map((item) => item.proposal_id));
  return decisions.find((item) => item.type !== "human_governance" && item.status === "proposed" && !completed.has(item.id)) ?? null;
}

function getLatestCompletedDecision(workspace) {
  const decisions = (workspace?.decisions ?? []).filter((item) => item.type === "human_governance");
  return decisions.at(-1) ?? null;
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
    <div className="architecture-conversation conversation natural-conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label="Architecture Manager messages">
      <div className="date-rule"><span>Conversation</span></div>
      {agent.status === "WORKING" && <div className="working-status" role="status">Architecture Manager is working…</div>}
      {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
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
