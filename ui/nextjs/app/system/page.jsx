"use client";
// SystemPage provides a project workspace for System Engineer agents.

import { applyOwnerExecutionDecision } from "../../lib/owner-execution-decision.js";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { SystemEngineerEvent } from "../../components/system-engineer-event.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { SystemEngineerReply } from "../../components/system-engineer-reply.jsx";
import { systemEngineerEventText } from "../../components/system-engineer-event.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationSidebar } from "../../components/conversation-sidebar.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationsAccordion } from "../../components/ConversationsAccordion.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationResponseReveal } from "../../components/conversation-response-reveal.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { HomeChatComposer } from "../../components/home-chat-composer.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationAgentMessageActions, ConversationMessageActions } from "../../components/conversation-message-actions.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { PendingConversationQueue, usePendingConversationQueue } from "../../components/conversation-pending-queue.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GlobalToast } from "../../components/GlobalToast.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { InlineError } from "../../components/InlineError.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { MarkdownPreviewPanel } from "../../components/markdown-preview-panel.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { WorkspaceMonitorPanels } from "../../components/WorkspaceMonitorPanels.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { SystemExecutionControls } from "../../components/system-execution-controls.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ConversationProjectGit } from "../../components/conversation-project-git.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { SystemToolMode } from "../../components/system-tool-mode.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { createNodeClient, MESSAGE_INTENTS } from "../../lib/node-client.js";
import { useParams, usePathname } from "next/navigation";
import { architectureManagerSelection, writeArchitectureManagerAgent } from "../../lib/architecture-manager-selection.js";
import { resolveActiveProjectId } from "../../lib/home-page-constants.js";
import { readChatState, writeChatState } from "../../lib/home-page-conversation-state.js";
import { displayMessageTime, agentDisplayName } from "../../lib/home-page-watcher-events.js";
import { useProjectEventStream } from "../../lib/home-page-event-stream.js";
import { createHomeMessageHandlers } from "../../lib/home-page-message-handlers.js";
import { useConversationMessageHistory } from "../../lib/use-conversation-message-history.js";
import { normalizeUiError } from "../../lib/ui-error.js";

// Opens and restores a conversation with a configured System Engineer agent in the System workspace.
export default function SystemPage({ sectionTitle = "System", projectId: propProjectId } = {}) {
  let params = null;
  let pathname = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Safe in Next App Router and guarded for standalone browser bundles.
    params = useParams();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Safe in Next App Router and guarded for standalone browser bundles.
    pathname = usePathname();
  } catch (error) {
    params = null; pathname = null;
  }
  const routeProjectId = Array.isArray(params?.projectId) ? params.projectId[0] : params?.projectId;
  const PROJECT_ID = resolveActiveProjectId({ explicitProjectId: propProjectId, routeProjectId, pathname });
  const CODING_AGENT_SELECTION_KEY = `${PROJECT_ID}:coding`;
  const CODING_CHAT_STATE_KEY = `nodeforge:coding:last:${PROJECT_ID}`;
  const client = useMemo(() => createNodeClient(PROJECT_ID), [PROJECT_ID]);
  const chatMessagesRef = useRef(null);
  const [agentDirectory, setAgentDirectory] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const activeConversationIdRef = useRef(null);
  const agentDirectoryRef = useRef([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [watcherEvents, setWatcherEvents] = useState([]);
  const [watcherState, setWatcherState] = useState("connecting");
  const [, setWatcherPulseId] = useState(0);
  const [agentProcess, setAgentProcess] = useState(null);
  const [agentActivities, setAgentActivities] = useState([]);
  const [chatState, setChatState] = useState("");
  const [globalError, setGlobalError] = useState(null);
  const [openSidebar, setOpenSidebar] = useState(false);
  const [conversationRevision, setConversationRevision] = useState(0);
  const [markdownPreviewPath, setMarkdownPreviewPath] = useState("");
  const sendingRef = useRef(false);
  const lastSentRef = useRef(null);
  const systemAgents = useMemo(() => agentDirectory
    .filter((agent) => agent?.role === "system_engineer" && agent?.enabled === true)
    .map((agent) => ({ ...agent, id: agent.agent_id ?? agent.id, label: agent.agent_name ?? agent.name ?? agent.label ?? agent.agent_id ?? agent.id }))
    .filter((agent) => agent.id), [agentDirectory]);
  const selectedAgent = systemAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  activeConversationIdRef.current = activeConversationId ?? selectedAgent?.conversation_id ?? selectedAgent?.conversationId ?? null;
  agentDirectoryRef.current = agentDirectory;
  const [systemInterruption, setSystemInterruption] = useState(0);
  // Counts terminal conversation failures so recovery controls re-read the durable checkpoint without a page reload.
  const noteStreamInterruption = useCallback((event) => {
    const failed = (event?.event_type === "agent.activity" && event?.payload?.activity_type === "failed") || event?.event_type === "conversation.message.failed";
    if (failed && event?.payload?.conversation_id === activeConversationIdRef.current) setSystemInterruption((current) => current + 1);
  }, []);
  const { messages, setMessages, messagesLoading, setMessagesLoading, olderLoading, hasOlder, historyError,
    loadConversationMessages, loadEarlierMessages, handleMessageScroll, followLatest } = useConversationMessageHistory({
    client, projectId: PROJECT_ID, chatMessagesRef, agentDirectoryRef, agentDisplayName
  });

  useEffect(() => {
    setConversations([]); setActiveConversationId(null); activeConversationIdRef.current = null;
    setMessages([]); setWatcherEvents([]); setAgentActivities([]); setAgentProcess(null);
    setAgentTyping(false); setChatState(""); setGlobalError(null); setMarkdownPreviewPath("");
    lastSentRef.current = null; sendingRef.current = false;
  }, [PROJECT_ID, setMessages]);

  useEffect(() => {
    let active = true;
    client.getAgents("system_engineer").then((payload) => {
      if (!active) return;
      const agents = Array.isArray(payload) ? payload : payload?.agents ?? payload?.items ?? [];
      const eligible = agents.filter((agent) => agent?.role === "system_engineer" && agent?.enabled === true);
      setAgentDirectory(agents);
      const saved = architectureManagerSelection(CODING_AGENT_SELECTION_KEY, "");
      const selected = eligible.find((agent) => (agent.agent_id ?? agent.id) === saved) ?? eligible[0];
      setSelectedAgentId(selected?.agent_id ?? selected?.id ?? "");
    }).catch((error) => { console.error("Unable to load system agents", error); if (active) setGlobalError(normalizeUiError(error, { fallback: "Could not load system agents." })); });
    return () => { active = false; };
  }, [client, CODING_AGENT_SELECTION_KEY]);

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
        if (activeConversationIdRef.current === "") return;
        const saved = readChatState(CODING_CHAT_STATE_KEY);
        const savedId = saved?.agent_id === selectedAgent.id ? saved.conversation_id : null;
        const selected = items.find((item) => (item.id ?? item.conversation_id) === savedId) ?? items[0] ?? null;
        const conversationId = selected?.id ?? selected?.conversation_id ?? null;
        setActiveConversationId(conversationId);
        if (conversationId) { writeChatState(CODING_CHAT_STATE_KEY, selectedAgent.id, conversationId); void loadConversationMessages(conversationId); }
        else { setMessages([]); setMessagesLoading(false); }
      } catch (error) {
        if (!active) return;
        setConversations([]); setMessagesLoading(false);
        setGlobalError({ ...normalizeUiError(error, { fallback: "Could not load system conversations." }), _retry: loadConversations });
      }
    }
    void loadConversations();
    return () => { active = false; };
  }, [client, PROJECT_ID, CODING_CHAT_STATE_KEY, selectedAgent?.id]);

  useProjectEventStream({
    client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef, setMessages, setAgentTyping,
    setWatcherEvents, setWatcherPulseId, setWatcherState, setAgentProcess, setAgentActivities,
    agentDisplayName, onProjectEvent: noteStreamInterruption, onConversationReconnect: loadConversationMessages
  });

  // Starts an unsaved chat without creating a conversation or cancelling the previous agent run.
  function handleNewConversation() {
    if (sendingRef.current) return;
    activeConversationIdRef.current = "";
    setActiveConversationId("");
    void loadConversationMessages(null);
    setConversationRevision((current) => current + 1);
    setChatState(""); setGlobalError(null); setAgentTyping(false);
    setMarkdownPreviewPath(""); lastSentRef.current = null;
    writeChatState(CODING_CHAT_STATE_KEY, selectedAgent?.id, null);
  }

  // Adds the first-message conversation to navigation without reloading its optimistic messages.
  function handleConversationCreated(conversation) {
    activeConversationIdRef.current = conversation.id ?? conversation.conversation_id;
    setConversations((current) => [conversation, ...current.filter((item) => (item.id ?? item.conversation_id) !== activeConversationIdRef.current)]);
  }

  // Selects the active system conversation and loads its persisted message history.
  function handleSelectConversation(conversation) {
    if (sendingRef.current) return;
    setConversationRevision((current) => current + 1);
    const id = conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId;
    if (!id) return;
    activeConversationIdRef.current = id;
    setActiveConversationId(id); writeChatState(CODING_CHAT_STATE_KEY, selectedAgent?.id, id);
    setMessages([]); setChatState(""); setAgentTyping(false); void loadConversationMessages(id);
  }

  const { sendMessage, editMessage, retryMessage, retryLastMessage } = createHomeMessageHandlers({
    client, projectId: PROJECT_ID, architectureConversationId: null, chatStateKey: CODING_CHAT_STATE_KEY,
    selectedArchitectureManager: selectedAgent, activeConversationId, setActiveConversationId, onConversationCreated: handleConversationCreated,
    setChatState, setMessages, setAgentTyping, sendingRef, lastSentRef, writeChatState, messageIntent: MESSAGE_INTENTS.normalChat, executionRole: "system-engineer"
  });
  const sendQueuedMessage = (text, responseContentType) => {
    followLatest();
    return sendMessage(text, responseContentType).catch((error) => {
      const normalized = normalizeUiError(error, { fallback: "Node rejected the system request." });
      setGlobalError({ ...normalized, _retry: retryLastMessage });
      throw error;
    });
  };
  const { pendingMessages, submitMessage, cancelPendingMessage } = usePendingConversationQueue({
    agentId: selectedAgent?.id, scopeKey: `${PROJECT_ID}:${conversationRevision}`, isWorking: agentTyping, onSend: sendQueuedMessage
  });
  const globalToastError = globalError ?? (chatState && !chatState.includes("successfully") ? chatState : null);
  const activeConversation = conversations.find((conversation) => String(conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId) === String(activeConversationId));
  const activeConversationTitle = activeConversation?.title ?? activeConversation?.name ?? "New system conversation";
  const displayMessages = groupAgentTurnMessages(messages);

  return <div className={`claude-home-shell system-workspace${markdownPreviewPath ? " has-markdown-preview" : ""}`} data-project-id={PROJECT_ID}>
    <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle={sectionTitle} architectureLabel={selectedAgent?.label} projects={[{ id: PROJECT_ID, name: PROJECT_ID }]} selectedProjectId={PROJECT_ID} onProjectChange={() => {}} onNewConversation={handleNewConversation} architectureControl={<div className="claude-architecture-list" role="listbox" aria-label={`${sectionTitle} agents`}>
      {systemAgents.map((agent) => <button type="button" role="option" aria-selected={agent.id === selectedAgentId} key={agent.id} onClick={() => { setSelectedAgentId(agent.id); writeArchitectureManagerAgent(CODING_AGENT_SELECTION_KEY, agent.id); }}><span className="claude-agent-option-avatar" aria-hidden="true">{agent.label.trim().slice(0, 1).toUpperCase()}</span><span>{agent.label}</span>{agent.id === selectedAgentId && <span className="claude-agent-option-check" aria-label="Selected agent">✓</span>}</button>)}
      {systemAgents.length === 0 && <p className="claude-coding-empty">No enabled System Engineer agent is available.</p>}
    </div>}>
      <ConversationsAccordion conversations={conversations} projectId={PROJECT_ID} agentId={selectedAgent?.id} activeConversationId={activeConversationId} onSelectConversation={handleSelectConversation} showNewConversationButton={false} />
    </ConversationSidebar>
    <main className="claude-home-main" aria-label="NodeForge system workspace">
      <section className="claude-chat" aria-label="System chat">
        <header className="claude-chat-header">
          <h1>{activeConversationTitle}</h1>
        </header>
        <div className="claude-chat-scroll" ref={chatMessagesRef} onScroll={handleMessageScroll} role="log" aria-live="polite">
          {messagesLoading && <p className="claude-chat-status">Loading conversation…</p>}
          {hasOlder && messages.length > 0 && <button className="claude-history-more" type="button" disabled={olderLoading} onClick={loadEarlierMessages}>{olderLoading ? "Loading…" : "Show earlier messages"}</button>}
          {historyError && <InlineError error={historyError} onRetry={() => void (hasOlder ? loadEarlierMessages() : loadConversationMessages(activeConversationId))} />}
          {!messagesLoading && messages.length === 0 && <div className="claude-welcome"><span className="claude-welcome-mark">⌘</span><h1>What should we build?</h1><p>Start a conversation with your project agent.</p></div>}
          {displayMessages.map((message) => {
            if (message.se_event?.type === "conversation_turn") return <SystemEngineerReply key={message.stream_key ?? message.id} message={message} displayMessageTime={displayMessageTime} onMarkdownOpen={setMarkdownPreviewPath} />;
            if (message.se_event && !systemEngineerEventText(message.se_event)) return null;
            return <article className={`claude-message ${message.from === "owner" ? "is-owner" : "is-agent"}`} key={message.stream_key ?? message.id}>
            <div className="claude-message-meta"><span>{message.timeline ? transcriptAgentName(message) : message.nickname ?? (message.from === "owner" ? "You" : "System Engineer")}</span><time dateTime={message.timestamp}>{displayMessageTime(message.timestamp)}</time></div>
            {message.timeline ? message.timeline.map((entry) => entry.se_event ? <SystemEngineerEvent key={entry.stream_key ?? entry.id} value={entry.se_event} /> : <ConversationResponseReveal key={entry.stream_key ?? entry.id} text={entry.text} contentType="text/markdown" reveal={entry.reveal === true} onMarkdownOpen={setMarkdownPreviewPath} onReveal={() => { const container = chatMessagesRef.current; if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 72) container.scrollTop = container.scrollHeight; }} />) : message.se_event ? <SystemEngineerEvent value={message.se_event} /> : message.from === "owner" ? <ConversationMessageActions message={message} onEdit={editMessage} onRetry={(ownerMessage) => retryMessage(ownerMessage, activeConversationId)}><ConversationResponseReveal text={message.text} contentType={message.content_type} onMarkdownOpen={setMarkdownPreviewPath} /></ConversationMessageActions> : <ConversationAgentMessageActions message={message} client={client} projectId={PROJECT_ID}><ConversationResponseReveal text={message.text} contentType={message.from === "agent" ? "text/markdown" : "text/plain"} reveal={message.from === "agent" && message.reveal === true} onMarkdownOpen={setMarkdownPreviewPath} onReveal={() => { const container = chatMessagesRef.current; if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 72) container.scrollTop = container.scrollHeight; }} /></ConversationAgentMessageActions>}
            {message.from === "system" && message.retryable !== false && <button type="button" className="claude-retry" onClick={retryLastMessage}>Retry</button>}
          </article>;
          })}
          {agentTyping && <div className="claude-typing" role="status" aria-label="Waiting for agent response"><i /><i /><i /></div>}
        </div>
        <div className="claude-composer-wrap">
          <PendingConversationQueue pendingMessages={pendingMessages} onCancel={cancelPendingMessage} />
          <div className="conversation-statusbar">
            <ConversationProjectGit client={client} projectId={PROJECT_ID} />
            <SystemExecutionControls onDecision={(decision) => applyOwnerExecutionDecision({ ...decision, setAgentTyping, setMessages, setChatState, lastSentRef })} client={client} projectId={PROJECT_ID} conversationId={activeConversationId} executionId={lastSentRef.current?.conversationId === activeConversationId ? lastSentRef.current.correlationId : messages.findLast((message) => message.from === "owner" && message.correlation_id)?.correlation_id} agentTyping={agentTyping} interruptionSignal={systemInterruption} />
          </div>
          <HomeChatComposer key={conversationRevision} projectId={PROJECT_ID} agentId={selectedAgent?.id} onSend={submitMessage} />
          <SystemToolMode key={selectedAgent?.id} agent={selectedAgent} client={client} projectId={PROJECT_ID} busy={agentTyping} onSaved={(saved) => setAgentDirectory((current) => current.map((agent) => (agent.agent_id ?? agent.id) === saved.agent_id ? { ...agent, ...saved } : agent))} />
        </div>
      </section>
    </main>
    {markdownPreviewPath && <MarkdownPreviewPanel client={client} projectId={PROJECT_ID} path={markdownPreviewPath} onClose={() => setMarkdownPreviewPath("")} />}
    <WorkspaceMonitorPanels layoutScope="system" selectedAgentId={selectedAgent?.id ?? ""} watcherEvents={watcherEvents} watcherState={watcherState} agentProcess={agentProcess} agentActivities={agentActivities} agentDirectory={agentDirectory} />
    {globalToastError && <GlobalToast error={globalToastError} onRetry={globalError?._retry ?? retryLastMessage} onDismiss={() => { setGlobalError(null); setChatState(""); }} />}
  </div>;
}

// Groups all System Engineer commands and text from one correlated turn into one chat card.
// Event-time ordering stays inside the card so command records cannot fragment the agent reply.
function groupAgentTurnMessages(messages) {
  const groups = new Map();
  const output = [];
  for (const message of messages) {
    if (message.se_event?.type === "conversation_turn") { output.push(message); continue; }
    const agentTurn = message.correlation_id && (message.from === "agent" || message.se_event);
    if (!agentTurn) { output.push(message); continue; }
    const key = `agent-turn:${message.correlation_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...message, id: key, stream_key: key, from: "agent", se_event: null, text: "", timeline: [] };
      groups.set(key, group); output.push(group);
    }
    group.timeline.push(message);
  }
  return output;
}

// Keeps the grouped card labelled with the real agent identity rather than a command-specific suffix.
function transcriptAgentName(message) {
  const source = message.timeline?.find((entry) => entry.nickname)?.nickname ?? "Claude Agent";
  return source.replace(/ · command$/, "");
}
