// Subscribes the home workspace to the project-wide SSE stream: live chat messages, watcher activity, agent-process status, and dashboard-refresh triggers.

import { useEffect, useRef } from "react";
import { applyWatcherEvent } from "./home-page-watcher-events.js";
import { mergeConversationRevisions } from "./conversation-message-revisions.js";
import { appendSystemEngineerConversationEvent, withoutSystemEngineerReplyDuplicates } from "./system-engineer-conversation-events.js";

// Wires the home workspace's single project event stream and reconciles chat/watcher/dashboard state from it.
export function useProjectEventStream({
  client,
  projectId,
  activeConversationIdRef,
  agentDirectoryRef,
  setMessages: updateMessages,
  setAgentTyping,
  setWatcherEvents,
  setWatcherPulseId,
  setWatcherState,
  setAgentProcess,
  setAgentActivities,
  loadDashboard,
  onSprintDeleted,
  onTicketDeleted,
  onProjectEvent,
  onConversationReconnect,
  agentDisplayName
}) {
  // Reconciles ordinary reply frames with the SE's raw public text events, if present.
  const setMessages = (update) => updateMessages((current) => mergeConversationRevisions(withoutSystemEngineerReplyDuplicates(update(current))));
  const reconnectRef = useRef(onConversationReconnect);
  reconnectRef.current = onConversationReconnect;
  useEffect(() => {
    let opened = false;
    // An unavailable project admission makes stream connection throw synchronously; the workspace must surface an error state, not crash the page.
    let stream = null;
    try {
      stream = client.connectProjectStream({
      projectId,
      onOpen: () => {
        setWatcherState("connected"); onProjectEvent?.({ project_id: projectId, event_type: "stream.connected" });
        if (opened && activeConversationIdRef.current) {
          const conversationId = activeConversationIdRef.current;
          void Promise.resolve().then(() => reconnectRef.current?.(conversationId, { preserve: true })).catch((error) => {
            console.error("Conversation reconnect recovery failed.", error);
          });
        }
        opened = true;
      },
      onEvent: (event) => {
        if (event.project_id && event.project_id !== projectId) return;
        onProjectEvent?.(event);
        if (event.event_type === "agent.activity") {
          setAgentActivities?.((current) => [...current, event].slice(-50));
          setMessages((current) => appendSystemEngineerConversationEvent(current, event, activeConversationIdRef.current, agentDisplayName(event.payload?.agent_id, agentDirectoryRef.current)));
          if (event.payload?.sdk_event?.type === "conversation_turn" && event.payload.conversation_id === activeConversationIdRef.current) setAgentTyping(event.payload.status === "working");
          return;
        }
        if (event.event_type.startsWith("conversation.message.") || event.event_type === "conversation.agent.status_changed") {
          if (event.payload?.conversation_id !== activeConversationIdRef.current) return;
          const payload = event.payload ?? {};
          const key = event.event_type === "conversation.message.owner" || event.event_type === "conversation.message.created"
            ? `owner:${payload.supersedes_message_id ?? payload.message_id ?? event.event_id}`
            : `agent:${payload.correlation_id ?? payload.message_id ?? event.event_id}`;
          const timestamp = event.timestamp ?? new Date().toISOString();
          if (event.event_type === "conversation.agent.status_changed") {
            setAgentTyping(payload.status === "working");
            return;
          }
          if (event.event_type === "conversation.message.failed") {
            const code = payload.error?.code ?? "AGENT_ERROR";
            setMessages((current) => {
              if (current.some((message) => message.stream_key === `${key}:failed`)) return current;
              return [...current, { id: payload.message_id ?? event.event_id, stream_key: `${key}:failed`, text: payload.error?.message ?? "Agent request failed.", from: "system", nickname: "System", timestamp, retryable: payload.error?.retryable !== false, failedCode: code }];
            });
            setAgentTyping(false);
            return;
          }
          setMessages((current) => {
            const index = current.findIndex((message) => message.stream_key === key);
            if (index >= 0 && current[index].se_event?.type === "conversation_turn" && ["conversation.message.delta", "conversation.message.received", "conversation.message.completed"].includes(event.event_type)) return current;
            if (event.event_type === "conversation.message.owner" || event.event_type === "conversation.message.created") {
              if (current.some((message) => message.source_message_id === payload.message_id)) return current;
              const ownerIndex = index >= 0 ? index : current.findIndex((message) => message.from === "owner" && message.correlation_id === payload.correlation_id && message.pending);
              if (ownerIndex >= 0) {
                const next = [...current];
                next[ownerIndex] = { ...next[ownerIndex], id: payload.supersedes_message_id ?? next[ownerIndex].id, source_message_id: payload.message_id, text: payload.text ?? next[ownerIndex].text, pending: false };
                return next;
              }
              return [...current, { id: payload.supersedes_message_id ?? payload.message_id ?? event.event_id, source_message_id: payload.message_id, stream_key: key, text: payload.text ?? "", from: "owner", nickname: "You", timestamp }];
            }
            if (event.event_type === "conversation.message.delta") {
              const chunk = payload.chunk ?? payload.text ?? "";
              if (!chunk) return current;
              setAgentTyping(true);
              const contentType = effectiveAgentContentType(payload);
              if (index < 0) return [...current, { id: payload.message_id ?? event.event_id, correlation_id: payload.correlation_id, conversation_id: payload.conversation_id, stream_key: key, text: chunk, content_type: contentType, from: "agent", nickname: agentDisplayName(payload.agent_id, agentDirectoryRef.current), timestamp, stream: true, reveal: true }];
              const next = [...current];
              next[index] = { ...next[index], conversation_id: payload.conversation_id ?? next[index].conversation_id, text: `${next[index].text ?? ""}${chunk}`, content_type: contentType, stream: true, reveal: true };
              return next;
            }
            if (event.event_type === "conversation.message.received" || event.event_type === "conversation.message.completed") {
              setAgentTyping(false);
              const contentType = effectiveAgentContentType(payload);
              if (index < 0) return [...current, { id: payload.message_id ?? event.event_id, correlation_id: payload.correlation_id, conversation_id: payload.conversation_id, stream_key: key, text: payload.text ?? "", content_type: contentType, from: "agent", nickname: agentDisplayName(payload.agent_id, agentDirectoryRef.current), timestamp, reveal: true }];
              const next = [...current];
              next[index] = { ...next[index], id: payload.message_id ?? next[index].id, conversation_id: payload.conversation_id ?? next[index].conversation_id, text: payload.text ?? next[index].text, content_type: contentType, stream: false, timestamp };
              return next;
            }
            return current;
          });
          return;
        }
        setWatcherEvents((current) => applyWatcherEvent(current, event));
        const processPayload = event.payload?.agent_process ?? event.payload?.agentProcess ?? event.payload?.process ?? event.payload?.watcher?.agent_process ?? event.payload?.watcher?.agentProcess;
        if (processPayload) setAgentProcess((current) => ({ ...(current ?? {}), process: processPayload }));
        if (event.event_type === "sprint.deleted" && onSprintDeleted && typeof event.payload?.sprint_id === "string" && (!event.project_id || event.project_id === projectId)) {
          onSprintDeleted(event.payload.sprint_id);
        } else if (event.event_type === "ticket.deleted" && onTicketDeleted && typeof event.payload?.ticket_id === "string" && (!event.project_id || event.project_id === projectId)) {
          onTicketDeleted(event.payload.ticket_id, event.payload);
        } else if (["ticket.created", "ticket.updated", "ticket.status_changed", "ticket.deleted", "sprint.created", "sprint.updated", "sprint.deleted"].includes(event.event_type)) {
          loadDashboard?.();
        }
        if (["watcher.file_indexed", "watcher.file_removed"].includes(event.event_type)) {
          setWatcherPulseId((current) => current + 1);
        }
        if (event.event_type === "stream.connected" || event.event_type === "stream.snapshot") setWatcherState("connected");
        if (event.event_type === "stream.error") setWatcherState("error");
      },
      onError: () => setWatcherState("error")
    });
    } catch { setWatcherState("error"); return undefined; }
    return () => stream.close();
  }, [client, projectId, onProjectEvent]);
}

// Resolves live message format only from an explicit supported producer declaration.
function effectiveAgentContentType(payload) {
  if (["project_owner", "node", "user", "system"].includes(payload?.sender_role)) return "text/plain";
  return payload?.content_type === "text/markdown" ? "text/markdown" : "text/plain";
}
