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
import { createCodingAgentPanelRegistry, updateCodingAgentPanelRegistry, setCodingAgentPanelSource, closeCodingAgentPanel, openCodingAgentPanel } from "../../lib/coding-agent-panel-registry.js";
import { createCodingAgentPanelStatePersister, hydrateCodingAgentPanelRegistry, readCodingAgentPanelMembership, releaseRestoredPanelClosures } from "../../lib/coding-agent-panel-state.js";

// Show coding operations without exposing conversation-specific sidebar controls.
export default function CodingPage() {
  const client = useMemo(() => createNodeClient(), []);
  const planEvents = useMemo(() => createCodingPlanEvents(PROJECT_ID), []);
  const [agents, setAgents] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [openSidebar, setOpenSidebar] = useState(false);
  const [dashboardState, setDashboardState] = useState({ status: "loading", dashboard: null, error: null });
  const dashboardLoader = useMemo(() => createCodingDashboardLoader({ client, projectId: PROJECT_ID, onState: setDashboardState }), [client]);
  
  const [agentActivities, setAgentActivities] = useState([]);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  agentDirectoryRef.current = agents;
  const [agentPanelRegistry, setAgentPanelRegistry] = useState(createCodingAgentPanelRegistry);
  const panelStateStorage = useCallback(() => (typeof window === "undefined" ? null : window.localStorage), []);
  const panelPersister = useMemo(() => createCodingAgentPanelStatePersister({
    getStorage: panelStateStorage,
    log: (error) => console.error("Unable to persist coding panel presence", error)
  }), [panelStateStorage]);
  const restoredPanelMembershipRef = useRef(null);
  const panelsHydratedRef = useRef(false);

  // Restore saved open/closed presence once before defaults or live run evidence are processed.
  useEffect(() => {
    restoredPanelMembershipRef.current = readCodingAgentPanelMembership(panelStateStorage, PROJECT_ID,
      (error) => console.error("Unable to read coding panel presence", error));
    setAgentPanelRegistry((current) => hydrateCodingAgentPanelRegistry(current, restoredPanelMembershipRef.current, agentDirectoryRef.current));
  }, [panelStateStorage]);

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
    if (!agentsLoaded) return;
    setAgentPanelRegistry((current) => {
      let next = updateCodingAgentPanelRegistry(current, PROJECT_ID, [], agents);
      const membership = restoredPanelMembershipRef.current;
      if (membership) {
        next = hydrateCodingAgentPanelRegistry(next, membership, agents);
        next = releaseRestoredPanelClosures(next, membership);
        restoredPanelMembershipRef.current = null;
      }
      panelsHydratedRef.current = true;
      return next;
    });
  }, [agents, agentsLoaded]);

  // Persist identity membership only after saved presence is restored so defaults never overwrite storage.
  useEffect(() => {
    if (!panelsHydratedRef.current) return;
    panelPersister.save(PROJECT_ID, agentPanelRegistry);
  }, [agentPanelRegistry, panelPersister]);

  // Write the latest membership before unmount so navigation preserves the final open/closed set.
  useEffect(() => () => panelPersister.flush(), [panelPersister]);

  // Close only the selected project/agent panel while preserving its same-run closure policy.
  const onAgentPanelClose = useCallback((projectId, agentId) => {
    setAgentPanelRegistry((current) => closeCodingAgentPanel(current, projectId, agentId));
  }, []);

  // Open the panel for the selected working agent from the dock, bypassing streamed evidence for this explicit action.
  const onAgentPanelOpen = useCallback((projectId, agentId) => {
    setAgentPanelRegistry((current) => openCodingAgentPanel(current, projectId, agentId, agentDirectoryRef.current));
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
      setAgentsLoaded(true);
    }).catch((error) => console.error("Unable to load coding agents", error));
    void loadWorkspaceMonitor();
    return () => { active = false; dashboardLoader.cancel(); };
  }, [client, dashboardLoader, loadWorkspaceMonitor]);

  return <div className="claude-home-shell coding-workspace-shell">
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle="Code" projects={[{ id: PROJECT_ID, name: "NodeForge" }]} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} showConversationControls={false} />
    <CodingWorkspaceMonitor planEvents={planEvents} projectId={PROJECT_ID} dashboard={dashboardState.dashboard} dashboardState={dashboardState} client={client} onRefresh={loadWorkspaceMonitor} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} agentActivities={agentActivities} agentDirectory={agents} agentPanelRegistry={agentPanelRegistry} onAgentPanelClose={onAgentPanelClose} onAgentPanelOpen={onAgentPanelOpen} />
  </div>;
}
