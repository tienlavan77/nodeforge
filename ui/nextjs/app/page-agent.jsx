"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createNodeClient } from "../lib/node-client.js";

const AGENTS = [
  {
    id: "architecture-manager",
    label: "Architecture Manager",
    short: "AM",
    role: "Plans the system and keeps the project aligned",
    accent: "amber"
  },
  {
    id: "sprint-leader",
    label: "Sprint Leader",
    short: "SL",
    role: "Coordinates delivery and keeps work moving",
    accent: "blue"
  },
  {
    id: "builder",
    label: "Builder",
    short: "BU",
    role: "Turns approved plans into working changes",
    accent: "green"
  },
  {
    id: "reviewer",
    label: "Reviewer",
    short: "RV",
    role: "Checks quality, safety, and readiness",
    accent: "red"
  }
];

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return String(value);
}

function profileFields(profile) {
  return [
    ["Agent ID", profile.agent_id],
    ["Agent name", profile.agent_name],
    ["Provider", profile.provider],
    ["Model", profile.model],
    ["Gateway URL", profile.gateway_url],
    ["Connection", profile.enabled ? "Enabled" : "Disabled"],
    ["API key", profile.api_key_masked || (profile.api_key ? "Configured" : "Not configured")]
  ];
}

function capabilities(profile, agent) {
  if (Array.isArray(profile?.capabilities) && profile.capabilities.length) {
    return profile.capabilities;
  }
  return [agent.role, profile?.model ? `Works with ${profile.model}` : "Model configuration pending"];
}

export default function AgentPage() {
  const client = useMemo(() => createNodeClient(), []);
  const [selectedId, setSelectedId] = useState(AGENTS[0].id);
  const [profiles, setProfiles] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    client.getAgentSettings()
      .then((items) => {
        if (!cancelled) {
          setProfiles(Array.isArray(items) ? items : []);
          setState("ready");
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError?.message || "Agent profiles could not be loaded.");
          setState("error");
        }
      });
    return () => { cancelled = true; };
  }, [client]);

  const selectedAgent = AGENTS.find((agent) => agent.id === selectedId) || AGENTS[0];
  const profile = profiles.find((item) => item.agent_id === selectedAgent.id);
  const selectedCapabilities = profile ? capabilities(profile, selectedAgent) : [];

  return (
    <main className="agent-profile-page">
      <nav className="app-navigation" aria-label="Application navigation">
        <Link href="/">Control room</Link>
        <span aria-current="page">Agent Profile</span>
      </nav>

      <header className="agent-profile-header">
        <div>
          <p className="eyebrow">NODE CONTROL ROOM / AGENTS</p>
          <h1>Agent Profile</h1>
          <p className="agent-profile-intro">Know who is on the team, what they can do, and how they connect.</p>
        </div>
        <Link className="agent-profile-back" href="/">Back to control room <span aria-hidden="true">↗</span></Link>
      </header>

      <div className="agent-profile-layout">
        <nav className="agent-profile-list" aria-label="Project agents">
          <div className="agent-profile-list-heading">
            <p className="agent-profile-list-label">Project agents</p>
            <span>{AGENTS.length} total</span>
          </div>
          {AGENTS.map((agent) => {
            const isSelected = selectedAgent.id === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                className={`${isSelected ? "is-selected " : ""}accent-${agent.accent}`}
                onClick={() => setSelectedId(agent.id)}
                aria-pressed={isSelected}
              >
                <span className="agent-profile-avatar">{agent.short}</span>
                <span className="agent-profile-list-copy"><strong>{agent.label}</strong><small>{agent.role}</small></span>
                <span className="agent-profile-chevron" aria-hidden="true">→</span>
              </button>
            );
          })}
          <p className="agent-profile-list-note">Select an agent to inspect its live configuration.</p>
        </nav>

        <section className="agent-profile-card" aria-live="polite">
          {state === "loading" && <p className="agent-profile-state">Loading agent profile...</p>}
          {state === "error" && <div className="agent-profile-state error"><strong>Unable to load profiles</strong><p>{error}</p><Link href="/">Return to control room</Link></div>}
          {state === "ready" && !profile && (
            <div className="agent-profile-state">
              <span className={`agent-profile-avatar large accent-${selectedAgent.accent}`}>{selectedAgent.short}</span>
              <p className="eyebrow">PROFILE NOT CONFIGURED</p>
              <h2>{selectedAgent.label}</h2>
              <p>No connection or capability information is available for this agent yet.</p>
              <Link href="/">Open agent settings from the control room</Link>
            </div>
          )}
          {state === "ready" && profile && (
            <>
              <div className="agent-profile-card-heading">
                <span className={`agent-profile-avatar large accent-${selectedAgent.accent}`}>{selectedAgent.short}</span>
                <div>
                  <p className="eyebrow">AGENT PROFILE</p>
                  <h2>{profile.agent_name || selectedAgent.label}</h2>
                  <p className="agent-profile-role">{selectedAgent.role}</p>
                  <span className={`agent-profile-status ${profile.enabled ? "is-active" : "is-inactive"}`}>{profile.enabled ? "Active" : "Inactive"}</span>
                </div>
              </div>
              <div className="agent-profile-section">
                <div className="agent-profile-section-heading"><p className="eyebrow">CAPABILITIES</p><span>{selectedCapabilities.length} available</span></div>
                <ul className="agent-profile-capabilities">{selectedCapabilities.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="agent-profile-section">
                <p className="eyebrow">CONNECTION DETAILS</p>
                <dl className="agent-profile-details">{profileFields(profile).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{displayValue(value)}</dd></div>)}</dl>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
