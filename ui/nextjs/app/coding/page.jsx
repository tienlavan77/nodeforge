// Provide the Code workspace with legacy Sprint Plan controls and active coding-agent monitors.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.

// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingWorkspaceMonitor } from "../../components/coding-workspace-monitor.jsx";
import { useProjectEventStream } from "../../lib/home-page-event-stream.js";
import { createNodeClient } from "../../lib/node-client.js";
import { createCodingDashboardLoader } from "../../lib/coding-dashboard-loader.js";
import { createCodingPlanEvents } from "../../lib/coding-plan-events.js";
import { PROJECT_ID } from "../../lib/home-page-constants.js";
import { agentDisplayName } from "../../lib/home-page-watcher-events.js";

// Show coding operations without exposing conversation-specific sidebar controls.
export default function CodingPage() {
  const client = useMemo(() => createNodeClient(), []);
  const planEvents = useMemo(() => createCodingPlanEvents(PROJECT_ID), []);
  const [agents, setAgents] = useState([]);
  const [dashboardState, setDashboardState] = useState({ status: "loading", dashboard: null, error: null });
  const dashboardLoader = useMemo(() => createCodingDashboardLoader({ client, projectId: PROJECT_ID, onState: setDashboardState }), [client]);
  
  const [agentActivities, setAgentActivities] = useState([]);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  agentDirectoryRef.current = agents;

  // Refresh Registry Sprint scope while preserving structured diagnostics for the active page.
  const loadWorkspaceMonitor = useCallback((options) => dashboardLoader.load(options), [dashboardLoader]);
  // Apply a confirmed Sprint deletion locally instead of resetting the entire Coding dashboard.
  const onSprintDeleted = useCallback((sprintId) => dashboardLoader.removeSprint(sprintId), [dashboardLoader]);
  // Apply confirmed ticket deletion and its replacement Sprint basis without reloading unrelated cards.
  const onTicketDeleted = useCallback((ticketId, receipt) => dashboardLoader.removeTicket(ticketId, receipt), [dashboardLoader]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
    setMessages: () => {}, setAgentTyping: () => {}, setWatcherEvents: () => {}, setWatcherPulseId: () => {}, setWatcherState: () => {},
    setAgentProcess: () => {}, setAgentActivities, loadDashboard: loadWorkspaceMonitor, onSprintDeleted, onTicketDeleted, onProjectEvent: planEvents.publish, agentDisplayName
  });

  useEffect(() => {
    let active = true;
    client.getAgents().then((payload) => {
      if (!active) return;
      setAgents(Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? []);
    }).catch((error) => console.error("Unable to load coding agents", error));
    void loadWorkspaceMonitor();
    return () => { active = false; dashboardLoader.cancel(); };
  }, [client, dashboardLoader, loadWorkspaceMonitor]);

  return <div className="claude-home-shell">
    
    <CodingWorkspaceMonitor planEvents={planEvents} projectId={PROJECT_ID} dashboard={dashboardState.dashboard} dashboardState={dashboardState} client={client} onRefresh={loadWorkspaceMonitor} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} agentActivities={agentActivities} agentDirectory={agents} />
  </div>;
}
