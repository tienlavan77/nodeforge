"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PROGRESS_TYPES = new Set([
  "architecture.working",
  "agent.text_stream",
  "node.status_change",
  "node.command_result",
]);

// Keeps the Vite SSE contract in one reusable Client Component. Consumers can
// render the returned transcript/status or compose it with the migrated views.
export default function StreamingClient({ client, agents, conversations, projectId, timeoutMs = 15000, onEvent }) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("READY");
  const pendingCorrelation = useRef(null);
  const timeoutRef = useRef(null);
  const streamsRef = useRef([]);

  const clearPending = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    pendingCorrelation.current = null;
  }, []);

  const handleMessage = useCallback((message) => {
    const type = message?.message_type ?? "";
    const correlation = message?.correlation_id;
    if (correlation && correlation === pendingCorrelation.current && (PROGRESS_TYPES.has(type) || type.endsWith(".message.delta"))) {
      clearPending();
      setStatus("WORKING");
    }
    if (type.endsWith(".message.received")) {
      clearPending();
      setStatus(message.payload?.agent_status ?? "COMPLETED");
    } else if (type.endsWith(".error")) {
      clearPending();
      setStatus("FAILED");
    } else if (type === "node.status_change" && message.payload?.to === "running") {
      setStatus("WORKING");
    } else if (type === "node.status_change" && ["done", "completed", "failed"].includes(message.payload?.to)) {
      setStatus(message.payload.to === "failed" ? "FAILED" : "COMPLETED");
    }
    if (!type.endsWith(".tool.result") && !type.endsWith(".message.progress") && !type.endsWith(".progress") && !type.endsWith(".working")) {
      setMessages((current) => current.some((item) => item.message_id === message.message_id) ? current : [...current, message]);
    }
    onEvent?.(message);
  }, [clearPending, onEvent]);

  useEffect(() => {
    if (!client || !agents?.length) return undefined;
    streamsRef.current = agents.map((agent) => client.connectConversationStream({
      projectId,
      conversationId: conversations?.[agent.id] ?? agent.conversation_id,
      onMessage: handleMessage,
      onReplayComplete: () => setStatus((current) => current === "WORKING" ? "READY" : current),
      onError: () => { if (pendingCorrelation.current) { clearPending(); setStatus("FAILED"); } },
    }));
    return () => { streamsRef.current.forEach((stream) => stream?.close?.()); streamsRef.current = []; clearPending(); };
  }, [agents, client, conversations, projectId, handleMessage, clearPending]);

  const trackDispatch = useCallback((correlationId) => {
    clearPending();
    pendingCorrelation.current = correlationId;
    timeoutRef.current = setTimeout(() => {
      if (pendingCorrelation.current !== correlationId) return;
      pendingCorrelation.current = null;
      timeoutRef.current = null;
      setStatus("FAILED");
      setMessages((current) => [...current, { message_id: `timeout-${Date.now()}`, message_type: "system.timeout", payload: { text: "Builder did not start the ticket within the expected time." } }]);
    }, timeoutMs);
  }, [clearPending, timeoutMs]);

  return { messages, status, trackDispatch, clearPending };
}

export { PROGRESS_TYPES };
