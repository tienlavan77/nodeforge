// Provide the Code workspace with legacy Sprint Plan controls and active coding-agent monitors.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationSidebar } from "../../components/conversation-sidebar.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { CodingWorkspaceMonitor } from "../../components/coding-workspace-monitor.jsx";
import { useProjectEventStream } from "../../lib/home-page-event-stream.js";
import { createNodeClient } from "../../lib/node-client.js";
import { PROJECT_ID } from "../../lib/home-page-constants.js";
import { agentDisplayName } from "../../lib/home-page-watcher-events.js";

// Show coding operations without exposing conversation-specific sidebar controls.
export default function CodingPage() {
  const client = useMemo(() => createNodeClient(), []);
  const [agents, setAgents] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [openSidebar, setOpenSidebar] = useState(false);
  const [agentActivities, setAgentActivities] = useState([]);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  agentDirectoryRef.current = agents;

  // Refresh the legacy Sprint Plan projection when the project stream reports changes.
  const loadWorkspaceMonitor = useCallback(async () => {
    try {
      setDashboard(await client.getProjectDashboard(PROJECT_ID));
    } catch (error) {
      console.error("Unable to load coding sprint dashboard", error);
      setDashboard(null);
    }
  }, [client]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
    setMessages: () => {}, setAgentTyping: () => {}, setWatcherEvents: () => {}, setWatcherPulseId: () => {}, setWatcherState: () => {},
    setAgentProcess: () => {}, setAgentActivities, loadDashboard: loadWorkspaceMonitor, agentDisplayName
  });

  useEffect(() => {
    let active = true;
    client.getAgents().then((payload) => {
      if (!active) return;
      setAgents(Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? []);
    }).catch((error) => console.error("Unable to load coding agents", error));
    void loadWorkspaceMonitor();
    return () => { active = false; };
  }, [client, loadWorkspaceMonitor]);

  return <div className="claude-home-shell">
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle="Code" projects={[{ id: PROJECT_ID, name: "NodeForge" }]} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} showConversationControls={false} />
    <CodingWorkspaceMonitor dashboard={dashboard} client={client} onRefresh={loadWorkspaceMonitor} agentActivities={agentActivities} agentDirectory={agents} />
  </div>;
}
