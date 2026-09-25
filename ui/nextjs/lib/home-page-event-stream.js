// Subscribes the home workspace to the project-wide SSE stream: live chat messages, watcher activity, agent-process status, and dashboard-refresh triggers.

import { useEffect } from "react";
import { applyWatcherEvent } from "./home-page-watcher-events.js";

// Wires the home workspace's single project event stream and reconciles chat/watcher/dashboard state from it.
export function useProjectEventStream({
  client,
  projectId,
  activeConversationIdRef,
  agentDirectoryRef,
  setMessages,
  setAgentTyping,
  setWatcherEvents,
  setWatcherPulseId,
  setWatcherState,
  setAgentProcess,
  loadDashboard,
  agentDisplayName
}) {
  useEffect(() => {
    const stream = client.connectProjectStream({
      projectId,
      onOpen: () => setWatcherState("connected"),
      onEvent: (event) => {
        if (event.event_type.startsWith("conversation.message.") || event.event_type === "conversation.agent.status_changed") {
          if (event.payload?.conversation_id !== activeConversationIdRef.current) return;
          const payload = event.payload ?? {};
          const key = event.event_type === "conversation.message.owner" || event.event_type === "conversation.message.created"
            ? `owner:${payload.message_id ?? event.event_id}`
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
            if (event.event_type === "conversation.message.owner" || event.event_type === "conversation.message.created") {
              if (current.some((message) => message.id === payload.message_id)) return current;
              const ownerIndex = index >= 0 ? index : current.findIndex((message) => message.from === "owner" && message.correlation_id === payload.correlation_id && message.pending);
              if (ownerIndex >= 0) {
                const next = [...current];
                next[ownerIndex] = { ...next[ownerIndex], id: payload.message_id ?? next[ownerIndex].id, text: payload.text ?? next[ownerIndex].text, pending: false };
                return next;
              }
              return [...current, { id: payload.message_id ?? event.event_id, stream_key: key, text: payload.text ?? "", from: "owner", nickname: "You", timestamp }];
            }
            if (event.event_type === "conversation.message.delta") {
              const chunk = payload.chunk ?? payload.text ?? "";
              if (!chunk) return current;
              setAgentTyping(true);
              if (index < 0) return [...current, { id: payload.message_id ?? event.event_id, stream_key: key, text: chunk, from: "agent", nickname: agentDisplayName(payload.agent_id, agentDirectoryRef.current), timestamp, stream: true }];
              const next = [...current];
              next[index] = { ...next[index], text: `${next[index].text ?? ""}${chunk}`, stream: true };
              return next;
            }
            if (event.event_type === "conversation.message.received" || event.event_type === "conversation.message.completed") {
              setAgentTyping(false);
              if (index < 0) return [...current, { id: payload.message_id ?? event.event_id, stream_key: key, text: payload.text ?? "", from: "agent", nickname: agentDisplayName(payload.agent_id, agentDirectoryRef.current), timestamp }];
              const next = [...current];
              next[index] = { ...next[index], id: payload.message_id ?? next[index].id, text: payload.text ?? next[index].text, stream: false, timestamp };
              return next;
            }
            return current;
          });
          return;
        }
        setWatcherEvents((current) => applyWatcherEvent(current, event));
        const processPayload = event.payload?.agent_process ?? event.payload?.agentProcess ?? event.payload?.process ?? event.payload?.watcher?.agent_process ?? event.payload?.watcher?.agentProcess;
        if (processPayload) setAgentProcess((current) => ({ ...(current ?? {}), process: processPayload }));
        if (["ticket.created", "ticket.updated", "ticket.status_changed", "ticket.deleted", "sprint.created", "sprint.updated", "sprint.deleted"].includes(event.event_type)) {
          loadDashboard();
        }
        if (["watcher.file_indexed", "watcher.file_removed"].includes(event.event_type)) {
          setWatcherPulseId((current) => current + 1);
        }
        if (event.event_type === "stream.connected" || event.event_type === "stream.snapshot") setWatcherState("connected");
        if (event.event_type === "stream.error") setWatcherState("error");
      },
      onError: () => setWatcherState("error")
    });
    return () => stream.close();
  }, [client]);
}
