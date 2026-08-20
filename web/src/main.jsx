import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createNodeClient } from "./services/node-client.js";
import "./styles.css";

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet", status: "Reviewing roadmap", messages: [{ from: "agent", text: "Architecture baseline is aligned with the current project constraints.", time: "09:41" }, { from: "agent", text: "I have queued the next decision set for owner review.", time: "09:44" }] },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan", status: "Planning Sprint 13", messages: [{ from: "agent", text: "Sprint 13 has 8 tickets ready for prioritization.", time: "09:38" }, { from: "owner", text: "Keep the UI work focused on the Node control surface.", time: "09:39" }] },
  { id: "builder", label: "Builder", short: "BU", tone: "amber", status: "Implementing NF-135", messages: [{ from: "agent", text: "Web Control Shell scaffold is in progress.", time: "09:35" }, { from: "agent", text: "No backend integrations have been changed.", time: "09:40" }] },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green", status: "Waiting for changes", messages: [{ from: "agent", text: "I am waiting for the Builder handoff before review.", time: "09:31" }] }
];

function App() {
  const client = useMemo(() => createNodeClient(), []);
  const [activeAgent, setActiveAgent] = useState("architecture-manager");
  const [drafts, setDrafts] = useState({});
  const [messages, setMessages] = useState(() => Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.messages])));
  const active = AGENTS.find((agent) => agent.id === activeAgent);

  function send(agentId) {
    const text = drafts[agentId]?.trim();
    if (!text) return;
    const sent = client.sendOwnerMessage(agentId, text);
    setMessages((current) => ({ ...current, [agentId]: [...current[agentId], { from: "owner", text: sent.text, time: "now" }] }));
    setDrafts((current) => ({ ...current, [agentId]: "" }));
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><div><div className="brand-name">NODE CONTROL ROOM</div><div className="brand-sub">Human governance surface</div></div></div>
      <div className="topbar-meta"><span className="connection"><span className="live-dot" /> NODE ONLINE</span><span className="divider" /><span className="project-label">PROJECT <strong>NODEFORGE</strong></span><button className="icon-button" title="Open settings" aria-label="Open settings">&#9881;</button></div>
    </header>
    <main className="workspace">
      <section className="architecture-panel panel" aria-label="Architecture Manager conversation">
        <AgentPanel agent={AGENTS[0]} messages={messages[AGENTS[0].id]} draft={drafts[AGENTS[0].id] ?? ""} onDraft={(value) => setDrafts((current) => ({ ...current, [AGENTS[0].id]: value }))} onSend={() => send(AGENTS[0].id)} expanded onActivate={() => setActiveAgent(AGENTS[0].id)} active={activeAgent === AGENTS[0].id} />
      </section>
      <section className="agent-stack">
        {AGENTS.slice(1).map((agent) => <AgentPanel key={agent.id} agent={agent} messages={messages[agent.id]} draft={drafts[agent.id] ?? ""} onDraft={(value) => setDrafts((current) => ({ ...current, [agent.id]: value }))} onSend={() => send(agent.id)} onActivate={() => setActiveAgent(agent.id)} active={activeAgent === agent.id} />)}
      </section>
    </main>
    <footer className="statusbar"><div><span className="status-key">ACTIVE CHANNEL</span><span className="status-value">{active.label}</span></div><div className="event-status"><span className="pulse" /> Event stream ready <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
  </div>;
}

function AgentPanel({ agent, messages, draft, onDraft, onSend, onActivate, active, expanded }) {
  return <article className={`agent-panel panel ${expanded ? "expanded" : ""} ${active ? "is-active" : ""}`} onClick={onActivate}>
    <header className="agent-header"><div className={`agent-avatar ${agent.tone}`}>{agent.short}</div><div className="agent-heading"><h2>{agent.label}</h2><div className="agent-status"><span className="status-dot" /> {agent.status}</div></div><button className="panel-menu" title="Panel actions" aria-label={`${agent.label} panel actions`}>&#8942;</button></header>
    <div className="conversation" role="log" aria-label={`${agent.label} messages`}>
      <div className="date-rule"><span>Today</span></div>
      {messages.map((message, index) => <div className={`message-row ${message.from === "owner" ? "owner" : "agent"}`} key={`${message.time}-${index}`}><div className="message-bubble"><p>{message.text}</p><time>{message.time}</time></div></div>)}
      <div className="typing-line"><span className="typing-dots"><i /><i /><i /></span> Node is listening</div>
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder={`Message ${agent.label}...`} aria-label={`Message ${agent.label}`} /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}

createRoot(document.getElementById("root")).render(<App />);
