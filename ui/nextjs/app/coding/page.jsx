// Provide the Code workspace with legacy Sprint Plan controls and active coding-agent monitors.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationSidebar } from "../../components/conversation-sidebar.jsx";

// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingWorkspaceMonitor } from "../../components/coding-workspace-monitor.jsx";
import { useProjectEventStream } from "../../lib/home-page-event-stream.js";
import { createNodeClient } from "../../lib/node-client.js";
import { createCodingDashboardLoader } from "../../lib/coding-dashboard-loader.js";
import { createCodingPlanEvents } from "../../lib/coding-plan-events.js";
import { PROJECT_ID } from "../../lib/home-page-constants.js";
import { agentDisplayName } from "../../lib/home-page-watcher-events.js";
import { createCodingAgentPanelRegistry, updateCodingAgentPanelRegistry, setCodingAgentPanelSource, closeCodingAgentPanel } from "../../lib/coding-agent-panel-registry.js";

// Show coding operations without exposing conversation-specific sidebar controls.
export default function CodingPage() {
  const client = useMemo(() => createNodeClient(), []);
  const planEvents = useMemo(() => createCodingPlanEvents(PROJECT_ID), []);
  const [agents, setAgents] = useState([]);
  const [openSidebar, setOpenSidebar] = useState(false);
  const [dashboardState, setDashboardState] = useState({ status: "loading", dashboard: null, error: null });
  const dashboardLoader = useMemo(() => createCodingDashboardLoader({ client, projectId: PROJECT_ID, onState: setDashboardState }), [client]);
  
  const [agentActivities, setAgentActivities] = useState([]);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  agentDirectoryRef.current = agents;
  const [agentPanelRegistry, setAgentPanelRegistry] = useState(createCodingAgentPanelRegistry);

  // Retain working identities at delivery time independently of the shared fifty-action buffer.
  const onProjectEvent = useCallback((event) => {
    planEvents.publish(event);
    setAgentPanelRegistry((current) => updateCodingAgentPanelRegistry(current, PROJECT_ID, [event], agentDirectoryRef.current));
  }, [planEvents]);
  // Invalidate cached execution claims whenever the live source connects or disconnects.
  const setPanelSource = useCallback((status) => {
    setAgentPanelRegistry((current) => setCodingAgentPanelSource(current, status));
  }, []);
  useEffect(() => {
    setAgentPanelRegistry((current) => updateCodingAgentPanelRegistry(current, PROJECT_ID, [], agents));
  }, [agents]);

  // Close only the selected project/agent panel while preserving its same-run closure policy.
  const onAgentPanelClose = useCallback((projectId, agentId) => {
    setAgentPanelRegistry((current) => closeCodingAgentPanel(current, projectId, agentId));
  }, []);

  // Refresh Registry Sprint scope while preserving structured diagnostics for the active page.
  const loadWorkspaceMonitor = useCallback((options) => dashboardLoader.load(options), [dashboardLoader]);
  // Apply a confirmed Sprint deletion locally instead of resetting the entire Coding dashboard.
  const onSprintDeleted = useCallback((sprintId) => dashboardLoader.removeSprint(sprintId), [dashboardLoader]);
  // Apply confirmed ticket deletion and its replacement Sprint basis without reloading unrelated cards.
  const onTicketDeleted = useCallback((ticketId, receipt) => dashboardLoader.removeTicket(ticketId, receipt), [dashboardLoader]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
    setMessages: () => {}, setAgentTyping: () => {}, setWatcherEvents: () => {}, setWatcherPulseId: () => {}, setWatcherState: setPanelSource,
    setAgentProcess: () => {}, setAgentActivities, loadDashboard: loadWorkspaceMonitor, onSprintDeleted, onTicketDeleted, onProjectEvent, agentDisplayName
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

  return <div className="claude-home-shell coding-workspace-shell">
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle="Code" projects={[{ id: PROJECT_ID, name: "NodeForge" }]} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} showConversationControls={false} />
    <CodingWorkspaceMonitor planEvents={planEvents} projectId={PROJECT_ID} dashboard={dashboardState.dashboard} dashboardState={dashboardState} client={client} onRefresh={loadWorkspaceMonitor} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} agentActivities={agentActivities} agentDirectory={agents} agentPanelRegistry={agentPanelRegistry} onAgentPanelClose={onAgentPanelClose} />
  </div>;
}
