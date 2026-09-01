"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createNodeClient } from "../lib/node-client.js";

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet", role: "Plans the system and keeps the project aligned", focus: "Direction & architecture" },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan", role: "Coordinates delivery and keeps work moving", focus: "Planning & delivery" },
  { id: "builder", label: "Builder", short: "BU", tone: "amber", role: "Turns approved plans into working changes", focus: "Implementation" },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green", role: "Checks quality, safety, and readiness", focus: "Quality & release" }
];

function valueOrFallback(value, fallback = "Not provided") {
  if (value === null || value === undefined || value === "") return fallback;
  return typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : String(value);
}

function findProfile(profiles, id) {
  return profiles.find((item) => item?.agent_id === id || item?.id === id) ?? null;
}

function getCapabilities(profile, agent) {
  if (Array.isArray(profile?.capabilities) && profile.capabilities.length) return profile.capabilities;
  return [agent.focus, agent.role];
}

function DetailRow({ label, children }) {
  return <div className="agent-profile-detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

export default function AgentPage() {
  const client = useMemo(() => createNodeClient(), []);
  const [selectedId, setSelectedId] = useState(AGENTS[0].id);
  const [profiles, setProfiles] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    client.getAgentSettings()
      .then((items) => {
        if (!mounted) return;
        setProfiles(Array.isArray(items) ? items : []);
        setLoadState("ready");
      })
      .catch((requestError) => {
        if (!mounted) return;
        setError(requestError?.message || "Agent profiles could not be loaded from Node.");
        setLoadState("error");
      });
    return () => { mounted = false; };
  }, [client]);

  const agent = AGENTS.find((item) => item.id === selectedId) ?? AGENTS[0];
  const profile = findProfile(profiles, agent.id);
  const capabilities = profile ? getCapabilities(profile, agent) : [];
  const connected = Boolean(profile?.enabled);

  return (
    <div className="app-shell agent-profile-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div><div className="brand-name">NODE CONTROL ROOM</div><div className="brand-sub">Human governance surface</div></div>
        </div>
        <div className="topbar-meta">
          <span className="connection"><span className="live-dot" /> NODE ONLINE</span>
          <span className="divider" />
          <span className="project-label">PROJECT <strong>NODEFORGE</strong></span>
        </div>
      </header>

      <nav className="app-navigation" aria-label="Application navigation">
        <Link href="/">Control room</Link>
        <span aria-current="page">Agent Profile</span>
      </nav>

      <main className="workspace agent-profile-workspace">
        <header className="agent-profile-page-header">
          <div>
            <p className="eyebrow">NODE CONTROL ROOM / AGENTS</p>
            <h1>Agent Profile</h1>
            <p className="agent-profile-intro">The people behind the process. Review each agent&apos;s role, capabilities, and live connection.</p>
          </div>
          <Link className="history-button agent-profile-home-link" href="/">Back to control room <span aria-hidden="true">↗</span></Link>
        </header>

        <div className="agent-profile-layout">
          <aside className="agent-profile-list panel" aria-label="Project agents">
            <div className="agent-profile-list-heading">
              <div><p className="eyebrow">TEAM DIRECTORY</p><h2>Project agents</h2></div>
              <span className="agent-profile-count">{AGENTS.length} total</span>
            </div>
            <div className="agent-profile-list-items">
              {AGENTS.map((item) => {
                const active = item.id === agent.id;
                const itemProfile = findProfile(profiles, item.id);
                return <button key={item.id} type="button" className={`agent-profile-list-item ${active ? "is-selected" : ""} ${item.tone}`} onClick={() => setSelectedId(item.id)} aria-pressed={active}>
                  <span className={`agent-avatar ${item.tone}`}>{item.short}</span>
                  <span className="agent-profile-list-copy"><strong>{item.label}</strong><small>{item.role}</small></span>
                  <span className={`agent-profile-list-indicator ${itemProfile?.enabled ? "is-connected" : ""}`} aria-label={itemProfile?.enabled ? "Connected" : "Not connected"} />
                  <span className="agent-profile-chevron" aria-hidden="true">→</span>
                </button>;
              })}
            </div>
            <p className="agent-profile-list-note">Select an agent to inspect its live configuration.</p>
          </aside>

          <section className="agent-profile-card panel" aria-live="polite" aria-label={`${agent.label} profile`}>
            {loadState === "loading" && <div className="agent-profile-state"><span className="typing-dots"><i /><i /><i /></span><p>Loading agent profiles from Node...</p></div>}
            {loadState === "error" && <div className="agent-profile-state error"><p className="eyebrow">PROFILE UNAVAILABLE</p><h2>Could not load agent data</h2><p>{error}</p><Link href="/">Return to control room</Link></div>}
            {loadState === "ready" && !profile && <div className="agent-profile-state agent-profile-empty-state"><span className={`agent-avatar large ${agent.tone}`}>{agent.short}</span><p className="eyebrow">NO PROFILE DATA</p><h2>{agent.label}</h2><p>This agent is part of the NodeForge team, but no profile data is available yet. Configure a provider connection from the control room to bring this profile online.</p><Link href="/">Open control room settings <span aria-hidden="true">↗</span></Link></div>}
            {loadState === "ready" && profile && <>
              <div className="agent-profile-card-heading">
                <span className={`agent-avatar large ${agent.tone}`}>{agent.short}</span>
                <div className="agent-profile-heading-copy"><p className="eyebrow">AGENT PROFILE</p><h2>{valueOrFallback(profile.agent_name, agent.label)}</h2><p className="agent-profile-role">{agent.role}</p><span className={`agent-status-badge ${connected ? "is-active" : "is-inactive"}`}><span className="status-dot" /> {connected ? "Connected" : "Not connected"}</span></div>
                <span className="agent-profile-id">{valueOrFallback(profile.agent_id, agent.id)}</span>
              </div>

              <div className="agent-profile-section agent-profile-capability-section">
                <div className="agent-profile-section-heading"><div><p className="eyebrow">CAPABILITIES</p><h3>What this agent can do</h3></div><span>{capabilities.length} available</span></div>
                <ul className="agent-profile-capabilities">{capabilities.map((capability, index) => <li key={`${capability}-${index}`}><span aria-hidden="true">+</span>{String(capability)}</li>)}</ul>
              </div>

              <div className="agent-profile-section">
                <div className="agent-profile-section-heading"><div><p className="eyebrow">CONNECTION DETAILS</p><h3>Provider configuration</h3></div><span className={connected ? "detail-live" : ""}>{connected ? "LIVE" : "OFFLINE"}</span></div>
                <dl className="agent-profile-details">
                  <DetailRow label="Agent ID">{valueOrFallback(profile.agent_id, agent.id)}</DetailRow>
                  <DetailRow label="Provider">{valueOrFallback(profile.provider)}</DetailRow>
                  <DetailRow label="Model">{valueOrFallback(profile.model)}</DetailRow>
                  <DetailRow label="Gateway URL">{valueOrFallback(profile.gateway_url)}</DetailRow>
                  <DetailRow label="API key">{profile.api_key_masked || (profile.api_key ? "Configured" : "Not configured")}</DetailRow>
                  <DetailRow label="Connection">{connected ? "Enabled" : "Disabled"}</DetailRow>
                </dl>
              </div>
            </>}
          </section>
        </div>
      </main>
      <footer className="statusbar"><div><span className="status-key">ACTIVE SURFACE</span><span className="status-value">AGENT PROFILE</span></div><div className="event-status"><span className="pulse" /> Node settings synced <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
    </div>
  );
}
