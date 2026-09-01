"use client";

import { useEffect, useMemo, useState } from "react";
import { createNodeClient } from "../lib/node-client.js";

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM" },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL" },
  { id: "builder", label: "Builder", short: "BU" },
  { id: "reviewer", label: "Reviewer", short: "RV" }
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

  return (
    <main className="agent-profile-page">
      <header className="agent-profile-header">
        <div>
          <p className="eyebrow">NODE CONTROL ROOM / AGENTS</p>
          <h1>Agent Profile</h1>
          <p className="agent-profile-intro">Review the configuration and connection details for each project agent.</p>
        </div>
        <a className="agent-profile-back" href="/">Back to control room</a>
      </header>

      <div className="agent-profile-layout">
        <nav className="agent-profile-list" aria-label="Agents">
          {AGENTS.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className={selectedAgent.id === agent.id ? "is-selected" : ""}
              onClick={() => setSelectedId(agent.id)}
            >
              <span className="agent-profile-avatar">{agent.short}</span>
              <span>{agent.label}</span>
            </button>
          ))}
        </nav>

        <section className="agent-profile-card" aria-live="polite">
          {state === "loading" && <p className="agent-profile-state">Loading agent profile...</p>}
          {state === "error" && <div className="agent-profile-state error"><strong>Unable to load profile</strong><p>{error}</p></div>}
          {state === "ready" && !profile && (
            <div className="agent-profile-state">
              <span className="agent-profile-avatar large">{selectedAgent.short}</span>
              <h2>{selectedAgent.label}</h2>
              <p>No profile information is available for this agent yet.</p>
              <a href="/">Open agent settings from the control room</a>
            </div>
          )}
          {state === "ready" && profile && (
            <>
              <div className="agent-profile-card-heading">
                <span className="agent-profile-avatar large">{selectedAgent.short}</span>
                <div><p className="eyebrow">AGENT PROFILE</p><h2>{profile.agent_name || selectedAgent.label}</h2><span className="agent-profile-status">{profile.enabled ? "Active" : "Inactive"}</span></div>
              </div>
              <dl className="agent-profile-details">
                {profileFields(profile).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{displayValue(value)}</dd></div>)}
              </dl>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
