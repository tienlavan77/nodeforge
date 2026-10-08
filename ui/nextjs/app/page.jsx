"use client";
// HomePage presents the NodeForge conversation workspace while preserving its existing project and stream contracts.

import { useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationSidebar } from "../components/conversation-sidebar.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationsAccordion } from "../components/ConversationsAccordion.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationResponseReveal } from "../components/conversation-response-reveal.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { HomeChatComposer } from "../components/home-chat-composer.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ArchitectureExecutionControls } from "../components/architecture-execution-controls.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationAgentMessageActions, ConversationMessageActions } from "../components/conversation-message-actions.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationProjectGit } from "../components/conversation-project-git.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { PendingConversationQueue, usePendingConversationQueue } from "../components/conversation-pending-queue.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GlobalToast } from "../components/GlobalToast.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { InlineError } from "../components/InlineError.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { MarkdownPreviewPanel } from "../components/markdown-preview-panel.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { WorkspaceMonitorPanels } from "../components/WorkspaceMonitorPanels.jsx";
import { createNodeClient, MESSAGE_INTENTS } from "../lib/node-client.js";
import { architectureManagerSelection, writeArchitectureManagerAgent } from "../lib/architecture-manager-selection.js";
import { PROJECT_ID, CHAT_STATE_KEY } from "../lib/home-page-constants.js";
import { readChatState, writeChatState } from "../lib/home-page-conversation-state.js";
import { displayMessageTime, agentDisplayName } from "../lib/home-page-watcher-events.js";
import { useProjectEventStream } from "../lib/home-page-event-stream.js";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";
import { useConversationMessageHistory } from "../lib/use-conversation-message-history.js";
import { normalizeUiError } from "../lib/ui-error.js";

// Renders the desktop conversation surface with the existing history, streaming, retry, and approval components.
export default function HomePage() {
  const client = useMemo(() => createNodeClient(), []);
  const chatMessagesRef = useRef(null);
  const [agentDirectory, setAgentDirectory] = useState([]);
  const [selectedArchitectureManagerId, setSelectedArchitectureManagerId] = useState("");
  const [chatState, setChatState] = useState("");
  const [openSidebar, setOpenSidebar] = useState(false);
  const [newConversationRequest, setNewConversationRequest] = useState(0);
  const [markdownPreviewPath, setMarkdownPreviewPath] = useState("");
  const projects = [{ id: PROJECT_ID, name: "NodeForge" }];
  const [watcherEvents, setWatcherEvents] = useState([]);
  const [watcherState, setWatcherState] = useState("connecting");
  const [, setWatcherPulseId] = useState(0);
  const [agentProcess, setAgentProcess] = useState(null);
  const [agentActivities, setAgentActivities] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [executionSignal, setExecutionSignal] = useState(0);
  const lastSentRef = useRef(null);
  const sendingRef = useRef(false);
  const [globalError, setGlobalError] = useState(null);

  const architectureManagers = useMemo(() => agentDirectory
    .filter((agent) => agent?.role === "architecture_manager" && agent?.enabled === true)
    .map((agent) => ({ ...agent, id: agent.agent_id ?? agent.id, label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id }))
    .filter((agent) => agent.id), [agentDirectory]);
  const selectedArchitectureManager = architectureManagers.find((agent) => agent.id === selectedArchitectureManagerId) ?? null;
  const streamConversationId = activeConversationId ?? selectedArchitectureManager?.conversation_id ?? selectedArchitectureManager?.conversationId ?? null;
  activeConversationIdRef.current = streamConversationId;
  agentDirectoryRef.current = agentDirectory;
  const { messages, setMessages, messagesLoading, setMessagesLoading, olderLoading, hasOlder, historyError,
    loadConversationMessages, loadEarlierMessages, handleMessageScroll, followLatest } = useConversationMessageHistory({
    client, projectId: PROJECT_ID, chatMessagesRef, agentDirectoryRef, agentDisplayName
  });

  useEffect(() => {
    let active = true;
    client.getAgents("architecture_manager").then((payload) => {
      if (!active) return;
      const agents = Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? [];
      setAgentDirectory(agents);
      const stored = architectureManagerSelection(PROJECT_ID, "");
      const selected = agents.find((agent) => (agent.agent_id ?? agent.id) === stored && agent?.role === "architecture_manager" && agent?.enabled === true)
        ?? agents.find((agent) => agent?.role === "architecture_manager" && agent?.enabled === true);
      setSelectedArchitectureManagerId(selected?.agent_id ?? selected?.id ?? "");
    }).catch(() => { if (active) setAgentDirectory([]); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!selectedArchitectureManager?.id) return undefined;
    let active = true;
    async function loadConversations() {
      try {
        const payload = await client.listConversations({ projectId: PROJECT_ID, agentId: selectedArchitectureManager.id });
        if (!active) return;
        const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.conversations ?? [];
        setConversations(items);
        const saved = readChatState(CHAT_STATE_KEY);
        const savedId = saved?.agent_id === selectedArchitectureManager.id ? saved.conversation_id : null;
        const selected = items.find((item) => (item.id ?? item.conversation_id) === savedId) ?? items[0] ?? null;
        const conversationId = selected?.id ?? selected?.conversation_id ?? null;
        setActiveConversationId(conversationId);
        if (conversationId) {
          writeChatState(CHAT_STATE_KEY, selectedArchitectureManager.id, conversationId);
          void loadConversationMessages(conversationId);
        }
      } catch (rawError) {
        if (!active) return;
        setConversations([]);
        setMessagesLoading(false);
        setGlobalError({ ...normalizeUiError(rawError, { fallback: "Could not load conversations." }), _retry: loadConversations });
      }
    }
    void loadConversations();
    return () => { active = false; };
  }, [client, selectedArchitectureManager?.id]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
    setMessages, setAgentTyping, setWatcherEvents, setWatcherPulseId, setWatcherState,
    setAgentProcess, setAgentActivities, onExecutionSignal: () => setExecutionSignal((current) => current + 1), agentDisplayName
  });

  // Binds a selected sidebar row to the existing persisted conversation and history lifecycle.
  function handleSelectConversation(conversation) {
    const id = conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId ?? null;
    if (!id) return;
    setActiveConversationId(id);
    writeChatState(CHAT_STATE_KEY, selectedArchitectureManager?.id, id);
    setMessages([]);
    setChatState("");
    setAgentTyping(false);
    void loadConversationMessages(id);
  }

  const { sendMessage, editMessage, retryMessage, retryLastMessage } = createHomeMessageHandlers({
    client, projectId: PROJECT_ID, architectureConversationId: null, chatStateKey: CHAT_STATE_KEY,
    selectedArchitectureManager, activeConversationId, setActiveConversationId,
    setChatState, setMessages, setAgentTyping, sendingRef, lastSentRef, writeChatState, messageIntent: MESSAGE_INTENTS.normalChat
  });
  const sendQueuedMessage = (text) => {
    followLatest();
    return sendMessage(text).catch((rawError) => {
      const error = normalizeUiError(rawError, { fallback: "Node rejected the message." });
      setGlobalError({ ...error, _retry: retryLastMessage });
      throw rawError;
    });
  };
  const { pendingMessages, submitMessage, cancelPendingMessage } = usePendingConversationQueue({
    agentId: selectedArchitectureManager?.id, isWorking: agentTyping, onSend: sendQueuedMessage
  });
  const globalToastError = globalError ?? (chatState && !chatState.includes("successfully") ? chatState : null);
  const activeConversation = conversations.find((conversation) => String(conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId) === String(activeConversationId));
  const activeConversationTitle = activeConversation?.title ?? activeConversation?.name ?? "New conversation";

  return <div className={`claude-home-shell${markdownPreviewPath ? " has-markdown-preview" : ""}`}>
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} architectureLabel={selectedArchitectureManager?.label} projects={projects} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} onNewConversation={() => setNewConversationRequest((current) => current + 1)} architectureControl={<div className="claude-architecture-list" role="listbox" aria-label="Architecture Manager agents">
      {architectureManagers.map((agent) => <button type="button" role="option" aria-selected={agent.id === selectedArchitectureManagerId} key={agent.id} onClick={() => { setSelectedArchitectureManagerId(agent.id); writeArchitectureManagerAgent(PROJECT_ID, agent.id); }}><span className="claude-agent-option-avatar" aria-hidden="true">{agent.label.trim().slice(0, 1).toUpperCase()}</span><span>{agent.label}</span>{agent.id === selectedArchitectureManagerId && <span className="claude-agent-option-check" aria-label="Selected architecture">✓</span>}</button>)}
    </div>}>
      <ConversationsAccordion conversations={conversations} projectId={PROJECT_ID} agentId={selectedArchitectureManager?.id} activeConversationId={activeConversationId} onNewConversation={(_title, conversation) => handleSelectConversation(conversation)} onSelectConversation={handleSelectConversation} createRequest={newConversationRequest} showNewConversationButton={false} />
    </ConversationSidebar>
    <main className="claude-home-main" aria-label="NodeForge conversation workspace">
      <section className="claude-chat" aria-label="Project chat">
        <header className="claude-chat-header"><h1>{activeConversationTitle}</h1></header>
        <div className="claude-chat-scroll" ref={chatMessagesRef} onScroll={handleMessageScroll} role="log" aria-live="polite">
          {messagesLoading && <p className="claude-chat-status">Loading conversation…</p>}
          {hasOlder && messages.length > 0 && <button className="claude-history-more" type="button" disabled={olderLoading} onClick={loadEarlierMessages}>{olderLoading ? "Loading…" : "Show earlier messages"}</button>}
          {historyError && <InlineError error={historyError} onRetry={() => void (hasOlder ? loadEarlierMessages() : loadConversationMessages(activeConversationId))} />}
          {!messagesLoading && messages.length === 0 && <div className="claude-welcome"><span className="claude-welcome-mark">N</span><h1>How can NodeForge help?</h1><p>Start a conversation with your project agent.</p></div>}
          {messages.map((message) => <article className={`claude-message ${message.from === "owner" ? "is-owner" : "is-agent"}`} key={message.stream_key ?? message.id}>
            <div className="claude-message-meta"><span>{message.nickname ?? (message.from === "owner" ? "You" : "NodeForge")}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div>
            {message.from === "owner" ? <ConversationMessageActions message={message} onEdit={editMessage} onRetry={(ownerMessage) => retryMessage(ownerMessage, activeConversationId)}><ConversationResponseReveal text={message.text} onMarkdownOpen={setMarkdownPreviewPath} /></ConversationMessageActions> : <ConversationAgentMessageActions message={message}><ConversationResponseReveal text={message.text} reveal={message.from === "agent" && message.reveal === true} onMarkdownOpen={setMarkdownPreviewPath} onReveal={() => { const container = chatMessagesRef.current; if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 72) container.scrollTop = container.scrollHeight; }} /></ConversationAgentMessageActions>}
            {message.from === "system" && message.retryable !== false && <button type="button" className="claude-retry" onClick={retryLastMessage}>Retry</button>}
          </article>)}
          {agentTyping && <div className="claude-typing" role="status" aria-label="Waiting for agent response"><i /><i /><i /></div>}
        </div>
        <div className="claude-composer-wrap">
          <PendingConversationQueue pendingMessages={pendingMessages} onCancel={cancelPendingMessage} />
          <div className="conversation-statusbar">
            <ConversationProjectGit client={client} projectId={PROJECT_ID} />
            <ArchitectureExecutionControls client={client} projectId={PROJECT_ID} conversationId={activeConversationId} executionId={lastSentRef.current?.conversationId === activeConversationId ? lastSentRef.current.correlationId : messages.findLast((message) => message.from === "owner" && message.correlation_id)?.correlation_id} agentTyping={agentTyping} onPause={setAgentTyping} refreshSignal={executionSignal} />
          </div>
          <HomeChatComposer onSend={submitMessage} />
          <p>NodeForge can make mistakes. Check important work.</p>
        </div>
      </section>
    </main>
    {markdownPreviewPath && <MarkdownPreviewPanel client={client} projectId={PROJECT_ID} path={markdownPreviewPath} onClose={() => setMarkdownPreviewPath("")} />}
    <WorkspaceMonitorPanels layoutScope="home" watcherEvents={watcherEvents} watcherState={watcherState} agentProcess={agentProcess} agentActivities={agentActivities} agentDirectory={agentDirectory} />
    {globalToastError && <GlobalToast error={globalToastError} onRetry={globalError?._retry ?? retryLastMessage} onDismiss={() => { setGlobalError(null); setChatState(""); }} />}
  </div>;
}
