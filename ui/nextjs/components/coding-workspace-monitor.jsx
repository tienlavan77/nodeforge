// Present the legacy Sprint Plan controls beside unified Coding workspace monitors.
"use client";

import { useEffect, useState } from "react";
import { displayMessageTime } from "../lib/home-page-watcher-events.js";
import { resolveCodingAgentActivities, resolveCodingAgentTone } from "../lib/coding-workspace-activity.js";
// eslint-disable-next-line no-unused-vars -- Next resolves these component references in JSX.
import { SprintPlanDashboard } from "./sprint-plan-panels.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingSprintDashboardState } from "./coding-sprint-dashboard-state.js";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingArchitecturePlans } from "./coding-architecture-plans.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationHeaderProjectGit } from "./conversation-project-git.jsx";

export { resolveCodingAgentActivities, resolveCodingAgentTone };

// Render the legacy Sprint Plan experience alongside unified Coding workspace monitors.
export function CodingWorkspaceMonitor({ planEvents, projectId, dashboard, dashboardState, client, onRefresh, onSprintDeleted, onTicketDeleted, agentActivities = [], agentDirectory = [], watcherEvents = [], watcherPulseId = null, watcherState = "connecting" }) {
  const [watcherActive, setWatcherActive] = useState(false);
  const [agentActive, setAgentActive] = useState(false);
  const visibleActivities = resolveCodingAgentActivities(agentActivities, agentDirectory, projectId);
  const scopedWatcherEvents = (Array.isArray(watcherEvents) ? watcherEvents : []).filter((event) => !projectId || !event?.project_id || event.project_id === projectId);
  const watcherItems = scopedWatcherEvents.slice().reverse().flatMap((event, eventIndex) => {
    const activities = Array.isArray(event?.payload?.activity) ? event.payload.activity : (event?.message ? [event.message] : []);
    const label = event?.event_type === "watcher.file_removed" ? "Removed" : event?.event_type === "watcher.file_indexed" ? "Indexed" : (event?.timestamp ? displayMessageTime(event.timestamp) : "Watcher");
    const time = displayMessageTime(event?.timestamp);
    return activities.map((activity, activityIndex) => ({
      key: `${event?.event_id ?? event?.timestamp ?? eventIndex}-${eventIndex}-${activityIndex}`,
      meta: time && label !== time ? `${label} · ${time}` : label,
      text: typeof activity === "string" ? activity : activity?.path ?? activity?.file_path ?? activity?.summary ?? JSON.stringify(activity)
    }));
  });
  const watcherStatus = watcherState === "connected" ? "Connected" : watcherState === "error" || watcherState === "disconnected" ? "Disconnected" : "Reconnecting";
  const indicatorClass = watcherState === "connected" ? "is-connected" : watcherState === "error" || watcherState === "disconnected" ? "is-error" : "is-connecting";

  const latestWatcherEvent = scopedWatcherEvents.at(-1);
  const latestWatcherKey = latestWatcherEvent ? `${latestWatcherEvent.event_id ?? ""}:${latestWatcherEvent.timestamp ?? ""}:${scopedWatcherEvents.length}` : "";
  const latestActivity = visibleActivities.at(-1);
  const latestActivityKey = latestActivity ? `${latestActivity.key}:${latestActivity.status}:${visibleActivities.length}` : "";
  const hasWorkingAgent = watcherState === "connected" && (() => {
    const statusByAgent = new Map();
    for (const item of visibleActivities) statusByAgent.set(item.agentId, item.status);
    for (const status of statusByAgent.values()) if (status === "working") return true;
    return false;
  })();

  useEffect(() => {
    if (watcherState !== "connected" || (!watcherPulseId && (!latestWatcherEvent?.timestamp || Date.now() - Date.parse(latestWatcherEvent.timestamp) > 3000))) { setWatcherActive(false); return undefined; }
    setWatcherActive(true);
    const timeout = typeof window !== "undefined" ? window.setTimeout(() => setWatcherActive(false), 3000) : null;
    return () => { if (timeout) window.clearTimeout(timeout); };
  }, [watcherState, watcherPulseId, latestWatcherKey]);

  useEffect(() => {
    if (watcherState !== "connected" || !latestActivityKey) { setAgentActive(false); return undefined; }
    setAgentActive(true);
    if (hasWorkingAgent) return undefined;
    const timeout = typeof window !== "undefined" ? window.setTimeout(() => setAgentActive(false), 3000) : null;
    return () => { if (timeout) window.clearTimeout(timeout); };
  }, [watcherState, latestActivityKey, hasWorkingAgent]);

  return <main className="coding-workspace-monitor" aria-label="Coding workspace monitor">
    <header className="claude-chat-header coding-workspace-header"><h1>Coding</h1><ConversationHeaderProjectGit client={client} projectId={projectId} /></header>
    <section className="coding-workspace-column coding-sprint-plan" aria-labelledby="coding-sprint-plan-heading">
      <header className="coding-workspace-column-header"><h1 id="coding-sprint-plan-heading">Sprint Plan</h1></header>
      {projectId && <CodingArchitecturePlans planEvents={planEvents} client={client} projectId={projectId} onHandoffCompleted={onRefresh} />}
      <CodingSprintDashboardState state={dashboardState ?? { status: "ready", dashboard }} onRetry={() => onRefresh?.({ manual: true })}>
        <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={onRefresh} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} hideHeading defaultCollapsed />
      </CodingSprintDashboardState>
    </section>
    <section className="coding-workspace-column coding-workspace-agent" aria-labelledby="coding-workspace-agent-heading">
      <header className="coding-workspace-column-header"><h1 id="coding-workspace-agent-heading">Workspace Agent</h1></header>
      <div className="coding-workspace-list">
        <div className="coding-workspace-row" aria-label="Workspace Agent upper row" />
        <div className="coding-workspace-row" aria-label="Workspace Agent monitors row">
          <section className="coding-workspace-monitor-column coding-agent-monitor" aria-label="Agents Activity monitor">
            <header className="workspace-monitor-header"><span className={`workspace-monitor-light${agentActive ? " is-active" : watcherState !== "connected" ? " is-offline" : ""}`} aria-label={agentActive ? "Agent working" : "Agent idle"} role="img" /><h3>Agents Activity</h3><span className={`workspace-monitor-indicator ${indicatorClass}`}>{watcherStatus}</span></header>
            <div className="workspace-monitor-content" aria-live="polite">
              {visibleActivities.length === 0 ? <p className="coding-workspace-empty">Waiting for agent activity.</p> : visibleActivities.slice().reverse().map((item) => <article key={item.key} data-agent-id={item.agentId}><small><strong style={{ color: item.tone }}>{item.agentName}</strong>{item.role ? ` - ${item.role}` : ""} · {item.activityType} · {item.status}{item.time ? ` · ${item.time}` : ""}</small><span>{item.detail}</span></article>)}
            </div>
          </section>
          <section className="coding-workspace-monitor-column coding-agent-monitor" aria-label="Watcher monitor">
            <header className="workspace-monitor-header"><span className={`workspace-monitor-light${watcherActive ? " is-active" : watcherState !== "connected" ? " is-offline" : ""}`} aria-label={watcherActive ? "Watcher working" : "Watcher idle"} role="img" /><h3>Watcher</h3><span className={`workspace-monitor-indicator ${indicatorClass}`}>{watcherStatus}</span></header>
            <div className="workspace-monitor-content" aria-live="polite">
              {watcherItems.length === 0 ? <p className="coding-workspace-empty">Waiting for watcher events.</p> : watcherItems.map((item) => <article key={item.key}><small>{item.meta}</small><span>{item.text}</span></article>)}
            </div>
          </section>
        </div>
      </div>
    </section>
  </main>;
}
