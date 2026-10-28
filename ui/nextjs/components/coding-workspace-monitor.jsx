// Present the legacy Sprint Plan controls beside active Coder and Reviewer work in Coding.
"use client";
// eslint-disable-next-line no-unused-vars -- The notebook control is rendered through JSX.
import { IdeasDock } from "./ideas-dock.jsx";

import { useState } from "react";
import { codingAgentPanelKey, codingAgentProfile, codingAgentPanelActions, codingAgentPanelStatus } from "../lib/coding-agent-panel-registry.js";
// eslint-disable-next-line no-unused-vars -- Next resolves these component references in JSX.
import { SprintPlanDashboard } from "./sprint-plan-panels.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingSprintDashboardState } from "./coding-sprint-dashboard-state.js";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingArchitecturePlans } from "./coding-architecture-plans.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GitStatusIndicator } from "./git-status-indicator.jsx";

// Render the legacy Sprint Plan experience alongside active Coding workspace agents.
export function CodingWorkspaceMonitor({ planEvents, projectId, dashboard, dashboardState, client, onRefresh, onSprintDeleted, onTicketDeleted, agentActivities = [], agentDirectory = [], onAgentPanelClose, onAgentPanelOpen, agentPanelRegistry = { panels: [], activity: {}, sourceStatus: "unknown" } }) {
  const panels = agentPanelRegistry.panels.filter((panel) => panel.projectId === projectId);
  const [minimizedPanels, setMinimizedPanels] = useState({});
  const openKeys = new Set(panels.map((panel) => panel.key));
  // Dock entries follow live working evidence for validated identities in this project only, never labels or roles.
  const workingAgents = Object.entries(agentPanelRegistry.activity ?? {})
    .flatMap(([key, status]) => status === "working" ? [codingPanelIdentity(key)] : [])
    .filter((identity) => identity?.projectId === projectId && codingAgentProfile(agentDirectory, identity.agentId, projectId));
  return <main className="coding-workspace-monitor" aria-label="Coding workspace monitor">
    <section className="coding-workspace-column coding-sprint-plan" aria-labelledby="coding-sprint-plan-heading">
      <header className="coding-workspace-column-header"><h1 id="coding-sprint-plan-heading">Sprint Plan</h1></header>
      {projectId && <CodingArchitecturePlans planEvents={planEvents} client={client} projectId={projectId} onHandoffCompleted={onRefresh} />}
      <CodingSprintDashboardState state={dashboardState ?? { status: "ready", dashboard }} onRetry={() => onRefresh?.({ manual: true })}>
        <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={onRefresh} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} hideHeading defaultCollapsed />
      </CodingSprintDashboardState>
    </section>
    <section className="coding-workspace-column coding-workspace-agent" aria-labelledby="coding-workspace-agent-heading">
      <header className="coding-workspace-column-header">
        <h1 id="coding-workspace-agent-heading">Workspace Agent</h1>
        <div className="coding-workspace-git-status"><GitStatusIndicator client={client} projectId={projectId} /></div>
      </header>
      <div className="coding-workspace-list">
        {panels.map((panel) => {
          const profile = codingAgentProfile(agentDirectory, panel.agentId, projectId);
          const actions = codingAgentPanelActions(agentActivities, agentDirectory, projectId, panel.agentId);
          const minimized = Boolean(minimizedPanels[panel.key]);
          const status = codingAgentPanelStatus(agentPanelRegistry, panel);
          const indicator = status === "working" ? " is-connected" : status === "disconnected" ? " is-error" : "";
          return <article key={panel.key} data-panel-key={panel.key} data-agent-id={panel.agentId} data-project-id={panel.projectId} className={`coding-agent-monitor${minimized ? " is-minimized" : ""}`}>
            <header className="workspace-monitor-header"><span className={`workspace-monitor-light${status === "working" ? " is-active" : ""}`} aria-hidden="true" /><strong>{profile?.agent_name ?? profile?.name ?? panel.agentId}</strong><span className={`workspace-monitor-indicator${indicator}`}>{status}</span><button type="button" aria-label={`${minimized ? "Expand" : "Minimize"} agent panel ${panel.agentId}`} onClick={() => setMinimizedPanels((current) => ({ ...current, [panel.key]: !current[panel.key] }))}>{minimized ? "□" : "−"}</button><button type="button" aria-label={`Close agent panel ${panel.agentId} in project ${panel.projectId}`} onClick={() => onAgentPanelClose?.(panel.projectId, panel.agentId)}>×</button></header>
            {!minimized && <div className="workspace-monitor-content" aria-live="polite">
              {actions.length === 0 && <p>Waiting for agent activity.</p>}
              {actions.slice().reverse().map((activity, index) => <article key={activity.event_id ?? index}><small>{[String(activity.payload.activity_type ?? "activity").replaceAll("_", " "), activity.payload.status, activity.timestamp ? new Date(activity.timestamp).toLocaleTimeString() : null].filter(Boolean).join(" · ")}</small><span>{activity.payload.summary}{activity.payload.tool_name ? ` (${activity.payload.tool_name})` : ""}</span></article>)}
            </div>}
          </article>;
        })}
        {panels.length === 0 && <p className="coding-workspace-empty">No agent panels are open.</p>}
      </div>
    </section>
    <div className="workspace-monitor-dock" role="group" aria-label="Coding agent monitors">
      <IdeasDock projectId={projectId} />
      {workingAgents.map(({ agentId }) => {
        const profile = codingAgentProfile(agentDirectory, agentId, projectId);
        const key = codingAgentPanelKey(projectId, agentId);
        return <button key={key} type="button" aria-pressed={openKeys.has(key)} onClick={() => onAgentPanelOpen?.(projectId, agentId)}><span className="workspace-monitor-light is-active" aria-hidden="true" />{profile?.agent_name ?? profile?.name ?? agentId}</button>;
      })}
    </div>
  </main>;
}

// Recover the validated project/agent identity encoded in a registry panel key.
function codingPanelIdentity(key) {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) ? { projectId: parsed[0], agentId: parsed[1] } : null;
    // eslint-disable-next-line no-silent-catch -- unparseable keys are registry internals, never dock candidates
  } catch (error) {
    return null;
  }
}
