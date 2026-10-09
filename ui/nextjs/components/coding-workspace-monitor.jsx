// Present the legacy Sprint Plan controls beside active Coder and Reviewer work in Coding.
"use client";

import { monitorAgentActivities } from "../lib/monitor-agent-activities.js";
import { SprintPlanDashboard } from "./sprint-plan-panels.jsx";
import { CodingSprintDashboardState } from "./coding-sprint-dashboard-state.js";

const WORKSPACE_AGENT_ROLES = ["coder", "reviewer"];

// Keep only the latest live activity for each Coding workspace agent.
function activeWorkspaceAgents(activities, agents) {
  const latestByAgent = new Map();
  for (const activity of monitorAgentActivities(activities, agents, WORKSPACE_AGENT_ROLES).slice().sort((left, right) => Date.parse(right.timestamp ?? "") - Date.parse(left.timestamp ?? ""))) {
    const agentId = activity.payload?.agent_id;
    if (agentId && !latestByAgent.has(agentId)) latestByAgent.set(agentId, activity);
  }
  return [...latestByAgent.values()].filter((activity) => activity.payload?.status === "working");
}

// Render the legacy Sprint Plan experience alongside active Coding workspace agents.
export function CodingWorkspaceMonitor({ dashboard, dashboardState, client, onRefresh, agentActivities = [], agentDirectory = [] }) {
  const agentNames = new Map(agentDirectory.map((agent) => [agent.agent_id ?? agent.id, agent.agent_name ?? agent.name ?? agent.agent_id ?? agent.id]));
  const activeAgents = activeWorkspaceAgents(agentActivities, agentDirectory);
  return <main className="coding-workspace-monitor" aria-label="Coding workspace monitor">
    <section className="coding-workspace-column coding-sprint-plan" aria-labelledby="coding-sprint-plan-heading">
      <h1 id="coding-sprint-plan-heading">Sprint Plan</h1>
      <CodingSprintDashboardState state={dashboardState ?? { status: "ready", dashboard }} onRetry={() => onRefresh?.({ manual: true })}>
        <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={onRefresh} hideHeading />
      </CodingSprintDashboardState>
    </section>
    <section className="coding-workspace-column coding-workspace-agent" aria-labelledby="coding-workspace-agent-heading">
      <h1 id="coding-workspace-agent-heading">Workspace Agent</h1>
      <div className="coding-workspace-list">
        {activeAgents.map((activity) => <article key={activity.event_id ?? [activity.payload.agent_id, activity.timestamp].join("-")} className="coding-agent-monitor">
          <header><strong>{agentNames.get(activity.payload.agent_id) ?? activity.payload.agent_id}</strong><span>{activity.payload.activity_type.replaceAll("_", " ")}</span></header>
          <p>{activity.payload.summary}</p>
          {activity.payload.tool_name && <small>{activity.payload.tool_name}</small>}
        </article>)}
        {activeAgents.length === 0 && <p className="coding-workspace-empty">No Coder or Reviewer is active.</p>}
      </div>
    </section>
  </main>;
}
