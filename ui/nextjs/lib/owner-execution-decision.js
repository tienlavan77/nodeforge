// Synchronize direct conversation activity with an acknowledged owner recovery decision.

// Release a discarded turn's chat state so queued or new messages can dispatch without reloading.
export function applyOwnerExecutionDecision({ action, executionId, nextExecutionId, setAgentTyping, setMessages, setChatState, lastSentRef }) {
  if (["continue", "restart"].includes(action)) {
    if (nextExecutionId && lastSentRef.current?.correlationId === executionId) lastSentRef.current = { ...lastSentRef.current, correlationId: nextExecutionId };
    setAgentTyping(true);
  }
  if (action !== "discard") return;
  setAgentTyping(false);
  setChatState("");
  setMessages((messages) => messages.map((message) => message.correlation_id === executionId || message.stream_key === `agent:${executionId}`
    ? { ...message, pending: false, stream: false } : message));
  if (lastSentRef.current?.correlationId === executionId) lastSentRef.current = null;
}
