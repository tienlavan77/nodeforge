// Present the legacy Sprint Plan controls beside active Coder and Reviewer work in Coding.
"use client";

import { codingAgentProfile, codingAgentPanelActions, codingAgentPanelStatus } from "../lib/coding-agent-panel-registry.js";
import { SprintPlanDashboard } from "./sprint-plan-panels.jsx";
import { CodingSprintDashboardState } from "./coding-sprint-dashboard-state.js";
import { CodingArchitecturePlans } from "./coding-architecture-plans.jsx";
import { GitStatusIndicator } from "./git-status-indicator.jsx";

// Render the legacy Sprint Plan experience alongside active Coding workspace agents.
export function CodingWorkspaceMonitor({ planEvents, projectId, dashboard, dashboardState, client, onRefresh, onSprintDeleted, onTicketDeleted, agentActivities = [], agentDirectory = [], onAgentPanelClose, agentPanelRegistry = { panels: [], activity: {}, sourceStatus: "unknown" } }) {
  const panels = agentPanelRegistry.panels.filter((panel) => panel.projectId === projectId);
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
          return <article key={panel.key} data-panel-key={panel.key} data-agent-id={panel.agentId} data-project-id={panel.projectId} className="coding-agent-monitor">
            <header><strong>{profile?.agent_name ?? profile?.name ?? panel.agentId}</strong><span>{profile?.role?.replaceAll("_", " ") ?? "Unknown role"}</span><button type="button" aria-label={`Close agent panel ${panel.agentId} in project ${panel.projectId}`} onClick={() => onAgentPanelClose?.(panel.projectId, panel.agentId)}>Close</button></header>
            <p>Activity: {codingAgentPanelStatus(agentPanelRegistry, panel)} · Profile: {profile?.status ?? "unknown"}</p>
            {actions.map((activity, index) => <div key={index}>
              <p>{activity.payload.summary}</p>
              {activity.payload.tool_name && <small>{activity.payload.tool_name}</small>}
            </div>)}
          </article>;
        })}
        {panels.length === 0 && <p className="coding-workspace-empty">No agent panels are open.</p>}
      </div>
    </section>
  </main>;
}
