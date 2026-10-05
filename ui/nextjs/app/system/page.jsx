"use client";
// SystemPage provides a project workspace for System Engineer agents.

import { useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationSidebar } from "../../components/conversation-sidebar.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationsAccordion } from "../../components/ConversationsAccordion.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationResponseReveal } from "../../components/conversation-response-reveal.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { HomeChatComposer } from "../../components/home-chat-composer.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationMessageActions } from "../../components/conversation-message-actions.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { PendingPlanApproval } from "../../components/pending-plan-approval.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GlobalToast } from "../../components/GlobalToast.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { InlineError } from "../../components/InlineError.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { MarkdownPreviewPanel } from "../../components/markdown-preview-panel.jsx";
import { createNodeClient, MESSAGE_INTENTS } from "../../lib/node-client.js";
import { architectureManagerSelection, writeArchitectureManagerAgent } from "../../lib/architecture-manager-selection.js";
import { PROJECT_ID, ARCHITECTURE_CONVERSATION_ID } from "../../lib/home-page-constants.js";
import { readChatState, writeChatState } from "../../lib/home-page-conversation-state.js";
import { displayMessageTime, agentDisplayName } from "../../lib/home-page-watcher-events.js";
import { useProjectEventStream } from "../../lib/home-page-event-stream.js";
import { createHomeMessageHandlers } from "../../lib/home-page-message-handlers.js";
import { useConversationMessageHistory } from "../../lib/use-conversation-message-history.js";
import { normalizeUiError } from "../../lib/ui-error.js";

const CODING_AGENT_SELECTION_KEY = `${PROJECT_ID}:coding`;
const CODING_CHAT_STATE_KEY = `nodeforge:coding:last:${PROJECT_ID}`;

// Opens and restores a conversation with a configured System Engineer agent in the System workspace.
export default function SystemPage() {
  const client = useMemo(() => createNodeClient(), []);
  const chatMessagesRef = useRef(null);
  const [agentDirectory, setAgentDirectory] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [chatState, setChatState] = useState("");
  const [globalError, setGlobalError] = useState(null);
  const [openSidebar, setOpenSidebar] = useState(false);
  const [newConversationRequest, setNewConversationRequest] = useState(0);
  const [markdownPreviewPath, setMarkdownPreviewPath] = useState("");
  const [editRequest, setEditRequest] = useState(null);
  const sendingRef = useRef(false);
  const lastSentRef = useRef(null);
  const systemAgents = useMemo(() => agentDirectory
    .filter((agent) => agent?.role === "system_engineer" && agent?.enabled === true)
    .map((agent) => ({ ...agent, id: agent.agent_id ?? agent.id, label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id }))
    .filter((agent) => agent.id), [agentDirectory]);
  const selectedAgent = systemAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  activeConversationIdRef.current = activeConversationId ?? selectedAgent?.conversation_id ?? selectedAgent?.conversationId ?? ARCHITECTURE_CONVERSATION_ID;
  agentDirectoryRef.current = agentDirectory;
  const { messages, setMessages, messagesLoading, setMessagesLoading, olderLoading, hasOlder, historyError,
    loadConversationMessages, loadEarlierMessages, handleMessageScroll, followLatest } = useConversationMessageHistory({
    client, projectId: PROJECT_ID, chatMessagesRef, agentDirectoryRef, agentDisplayName
  });

  useEffect(() => {
    let active = true;
    client.getAgents().then((payload) => {
      if (!active) return;
      const agents = Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? [];
      const eligible = agents.filter((agent) => agent?.role === "system_engineer" && agent?.enabled === true);
      setAgentDirectory(agents);
      const saved = architectureManagerSelection(CODING_AGENT_SELECTION_KEY, "");
      const selected = eligible.find((agent) => (agent.agent_id ?? agent.id) === saved) ?? eligible[0];
      setSelectedAgentId(selected?.agent_id ?? selected?.id ?? "");
    }).catch((error) => { console.error("Unable to load system agents", error); if (active) setGlobalError(normalizeUiError(error, { fallback: "Could not load system agents." })); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!selectedAgent?.id) { setConversations([]); setActiveConversationId(null); setMessages([]); setMessagesLoading(false); return undefined; }
    let active = true;
    // Restores this system agent's selected conversation and its saved messages.
    async function loadConversations() {
      try {
        const payload = await client.listConversations({ projectId: PROJECT_ID, agentId: selectedAgent.id });
        if (!active) return;
        const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.conversations ?? [];
        setConversations(items);
        const saved = readChatState(CODING_CHAT_STATE_KEY);
        const savedId = saved?.agent_id === selectedAgent.id ? saved.conversation_id : null;
        const selected = items.find((item) => (item.id ?? item.conversation_id) === savedId) ?? items[0] ?? null;
        const conversationId = selected?.id ?? selected?.conversation_id ?? null;
        setActiveConversationId(conversationId);
        if (conversationId) { writeChatState(CODING_CHAT_STATE_KEY, selectedAgent.id, conversationId); void loadConversationMessages(conversationId); }
        else setMessagesLoading(false);
      } catch (error) {
        if (!active) return;
        setConversations([]); setMessagesLoading(false);
        setGlobalError({ ...normalizeUiError(error, { fallback: "Could not load system conversations." }), _retry: loadConversations });
      }
    }
    void loadConversations();
    return () => { active = false; };
  }, [client, selectedAgent?.id]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef, setMessages, setAgentTyping,
    setWatcherEvents: () => {}, setWatcherPulseId: () => {}, setWatcherState: () => {}, setAgentProcess: () => {},
    loadDashboard: () => {}, agentDisplayName
  });

  // Selects the active system conversation and loads its persisted message history.
  function handleSelectConversation(conversation) {
    const id = conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId;
    if (!id) return;
    setActiveConversationId(id); writeChatState(CODING_CHAT_STATE_KEY, selectedAgent?.id, id);
    setMessages([]); setChatState(""); setAgentTyping(false); void loadConversationMessages(id);
  }

  const { sendMessage, retryMessage, retryLastMessage } = createHomeMessageHandlers({
    client, projectId: PROJECT_ID, architectureConversationId: ARCHITECTURE_CONVERSATION_ID, chatStateKey: CODING_CHAT_STATE_KEY,
    selectedArchitectureManager: selectedAgent, activeConversationId, setActiveConversationId,
    setChatState, setMessages, setAgentTyping, sendingRef, lastSentRef, writeChatState, messageIntent: MESSAGE_INTENTS.normalChat
  });
  const globalToastError = globalError ?? (chatState && !chatState.includes("successfully") ? chatState : null);
  const activeConversation = conversations.find((conversation) => String(conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId) === String(activeConversationId));
  const activeConversationTitle = activeConversation?.title ?? activeConversation?.name ?? "New system conversation";

  return <div className={`claude-home-shell system-workspace${markdownPreviewPath ? " has-markdown-preview" : ""}`}>
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle="System" architectureLabel={selectedAgent?.label} projects={[{ id: PROJECT_ID, name: "NodeForge" }]} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} onNewConversation={() => setNewConversationRequest((current) => current + 1)} architectureControl={<div className="claude-architecture-list" role="listbox" aria-label="System agents">
      {systemAgents.map((agent) => <button type="button" role="option" aria-selected={agent.id === selectedAgentId} key={agent.id} onClick={() => { setSelectedAgentId(agent.id); writeArchitectureManagerAgent(CODING_AGENT_SELECTION_KEY, agent.id); }}><span className="claude-agent-option-avatar" aria-hidden="true">{agent.label.trim().slice(0, 1).toUpperCase()}</span><span>{agent.label}</span>{agent.id === selectedAgentId && <span className="claude-agent-option-check" aria-label="Selected agent">✓</span>}</button>)}
      {systemAgents.length === 0 && <p className="claude-coding-empty">No enabled System Engineer agent is available.</p>}
    </div>}>
      <ConversationsAccordion conversations={conversations} projectId={PROJECT_ID} agentId={selectedAgent?.id} activeConversationId={activeConversationId} onNewConversation={(_title, conversation) => handleSelectConversation(conversation)} onSelectConversation={handleSelectConversation} createRequest={newConversationRequest} showNewConversationButton={false} />
    </ConversationSidebar>
    <main className="claude-home-main" aria-label="NodeForge system workspace">
      <section className="claude-chat" aria-label="System chat">
        <header className="claude-chat-header"><h1>{activeConversationTitle}</h1></header>
        <div className="claude-chat-scroll" ref={chatMessagesRef} onScroll={handleMessageScroll} role="log" aria-live="polite">
          {messagesLoading && <p className="claude-chat-status">Loading conversation…</p>}
          {hasOlder && messages.length > 0 && <button className="claude-history-more" type="button" disabled={olderLoading} onClick={loadEarlierMessages}>{olderLoading ? "Loading…" : "Show earlier messages"}</button>}
          {historyError && <InlineError error={historyError} onRetry={() => void loadEarlierMessages()} />}
          {!messagesLoading && messages.length === 0 && <div className="claude-welcome"><span className="claude-welcome-mark">⌘</span><h1>What should we build?</h1><p>Start a conversation with your project agent.</p></div>}
          {messages.map((message) => <article className={`claude-message ${message.from === "owner" ? "is-owner" : "is-agent"}`} key={message.stream_key ?? message.id}>
            <div className="claude-message-meta"><span>{message.nickname ?? (message.from === "owner" ? "You" : "System Engineer")}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div>
            <ConversationResponseReveal text={message.text} reveal={message.from === "agent" && message.reveal === true} onMarkdownOpen={setMarkdownPreviewPath} onReveal={() => { const container = chatMessagesRef.current; if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 72) container.scrollTop = container.scrollHeight; }} />
            {message.from === "owner" && <ConversationMessageActions message={message} onEdit={(text) => setEditRequest({ id: message.id, text })} onRetry={(ownerMessage) => retryMessage(ownerMessage, activeConversationId)} />}
            {message.from === "system" && message.retryable !== false && <button type="button" className="claude-retry" onClick={retryLastMessage}>Retry</button>}
          </article>)}
          {agentTyping && <div className="claude-typing" role="status" aria-label="Waiting for agent response"><i /><i /><i /></div>}
        </div>
        <div className="claude-composer-wrap">
          <PendingPlanApproval client={client} projectId={PROJECT_ID} projectName="NodeForge" messages={messages} conversationId={activeConversationId} agentId={selectedAgentId} />
          <HomeChatComposer editRequest={editRequest} onSend={(text) => { followLatest(); return sendMessage(text).catch((error) => { const normalized = normalizeUiError(error, { fallback: "Node rejected the system request." }); setGlobalError({ ...normalized, _retry: retryLastMessage }); throw error; }); }} />
          <p>Requests are sent to the selected system agent.</p>
        </div>
      </section>
    </main>
    {markdownPreviewPath && <MarkdownPreviewPanel client={client} projectId={PROJECT_ID} path={markdownPreviewPath} onClose={() => setMarkdownPreviewPath("")} />}
    {globalToastError && <GlobalToast error={globalToastError} onRetry={globalError?._retry ?? retryLastMessage} onDismiss={() => { setGlobalError(null); setChatState(""); }} />}
  </div>;
}
