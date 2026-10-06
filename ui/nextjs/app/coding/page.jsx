// Provide the Code workspace with conversation navigation without rendering a chat panel.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationSidebar } from "../../components/conversation-sidebar.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { WorkspaceMonitorPanels } from "../../components/WorkspaceMonitorPanels.jsx";
import { useProjectEventStream } from "../../lib/home-page-event-stream.js";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationsAccordion } from "../../components/ConversationsAccordion.jsx";
import { createNodeClient } from "../../lib/node-client.js";
import { architectureManagerSelection, writeArchitectureManagerAgent } from "../../lib/architecture-manager-selection.js";
import { PROJECT_ID } from "../../lib/home-page-constants.js";
import { agentDisplayName } from "../../lib/home-page-watcher-events.js";

const CODING_AGENT_SELECTION_KEY = `${PROJECT_ID}:coding`;

// Show the coding workspace's agent and conversation sidebar without system chat UI.
export default function CodingPage() {
  const client = useMemo(() => createNodeClient(), []);
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [openSidebar, setOpenSidebar] = useState(false);
  const [newConversationRequest, setNewConversationRequest] = useState(0);
  const [watcherEvents, setWatcherEvents] = useState([]);
  const [watcherState, setWatcherState] = useState("connecting");
  const [, setWatcherPulseId] = useState(0);
  const [agentProcess, setAgentProcess] = useState(null);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  const codingAgents = agents
    .filter((agent) => agent?.role === "system_engineer" && agent?.enabled === true)
    .map((agent) => ({ ...agent, id: agent.agent_id ?? agent.id, label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id }))
    .filter((agent) => agent.id);
  const selectedAgent = codingAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  activeConversationIdRef.current = activeConversationId;
  agentDirectoryRef.current = agents;
  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
    setMessages: () => {}, setAgentTyping: () => {}, setWatcherEvents, setWatcherPulseId, setWatcherState,
    setAgentProcess, loadDashboard: () => {}, agentDisplayName
  });

  useEffect(() => {
    let active = true;
    client.getAgents().then((payload) => {
      if (!active) return;
      const items = Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? [];
      const eligible = items.filter((agent) => agent?.role === "system_engineer" && agent?.enabled === true);
      setAgents(items);
      const stored = architectureManagerSelection(CODING_AGENT_SELECTION_KEY, "");
      const selected = eligible.find((agent) => (agent.agent_id ?? agent.id) === stored) ?? eligible[0];
      setSelectedAgentId(selected?.agent_id ?? selected?.id ?? "");
    }).catch((error) => console.error("Unable to load coding agents", error));
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!selectedAgent?.id) { setConversations([]); setActiveConversationId(null); return undefined; }
    let active = true;
    client.listConversations({ projectId: PROJECT_ID, agentId: selectedAgent.id }).then((payload) => {
      if (!active) return;
      const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.conversations ?? [];
      setConversations(items);
      const first = items[0];
      setActiveConversationId(first?.id ?? first?.conversation_id ?? null);
    }).catch((error) => { console.error("Unable to load coding conversations", error); if (active) setConversations([]); });
    return () => { active = false; };
  }, [client, selectedAgent?.id]);

  return <div className="claude-home-shell">
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle="Code" architectureLabel={selectedAgent?.label} projects={[{ id: PROJECT_ID, name: "NodeForge" }]} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} onNewConversation={() => setNewConversationRequest((current) => current + 1)} architectureControl={<div className="claude-architecture-list" role="listbox" aria-label="Code agents">
      {codingAgents.map((agent) => <button type="button" role="option" aria-selected={agent.id === selectedAgentId} key={agent.id} onClick={() => { setSelectedAgentId(agent.id); writeArchitectureManagerAgent(CODING_AGENT_SELECTION_KEY, agent.id); }}><span className="claude-agent-option-avatar" aria-hidden="true">{agent.label.trim().slice(0, 1).toUpperCase()}</span><span>{agent.label}</span>{agent.id === selectedAgentId && <span className="claude-agent-option-check" aria-label="Selected agent">✓</span>}</button>)}
      {codingAgents.length === 0 && <p className="claude-coding-empty">No enabled coding agent is available.</p>}
    </div>}>
      <ConversationsAccordion conversations={conversations} projectId={PROJECT_ID} agentId={selectedAgent?.id} activeConversationId={activeConversationId} onNewConversation={(_title, conversation) => setActiveConversationId(conversation?.id ?? conversation?.conversation_id ?? null)} onSelectConversation={(conversation) => setActiveConversationId(conversation?.id ?? conversation?.conversation_id ?? null)} createRequest={newConversationRequest} showNewConversationButton={false} />
    </ConversationSidebar>
    <WorkspaceMonitorPanels layoutScope="coding" watcherEvents={watcherEvents} watcherState={watcherState} agentProcess={agentProcess} />
  </div>;
}
