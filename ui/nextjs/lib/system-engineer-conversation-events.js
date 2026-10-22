// Restores versioned SE reply transcripts without leaking monitor events into another conversation.

// Recognizes the explicit SE transcript contract, leaving every other role unchanged.
export function isSystemEngineerConversationEvent(payload) {
  return payload?.agent_role === "system_engineer" && (payload.sdk_event?.type === "command_execution" && typeof payload.sdk_event.command === "string"
    || payload.sdk_event?.type === "conversation_turn" && Array.isArray(payload.sdk_event.entries));
}

// Converts live and persisted reply snapshots to the same stable assistant card identity.
export function systemEngineerConversationEvent({ id, payload, timestamp }, nickname) {
  if (!isSystemEngineerConversationEvent(payload) || !payload.conversation_id) return null;
  const activityId = payload.activity_id ?? id;
  if (!activityId) return null;
  const event = payload.sdk_event;
  if (event.type === "conversation_turn") {
    const text = event.entries.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
    return { id: activityId, source_message_id: id, conversation_id: payload.conversation_id, correlation_id: payload.correlation_id,
      stream_key: `agent:${payload.correlation_id}`, se_event: event, sdk_sequence: payload.sdk_sequence,
      timestamp: event.entries[0]?.timestamp ?? timestamp, text, from: "agent", nickname: nickname ?? payload.agent_id,
      retryable: false, status: payload.status, stream: payload.status === "working" };
  }
  return { id: activityId, source_message_id: id, conversation_id: payload.conversation_id, correlation_id: payload.correlation_id,
    stream_key: `se-event:${activityId}`, se_event: event, se_text: null, sdk_sequence: payload.sdk_sequence, status: payload.status,
    text: event.command, content_type: "text/plain", from: "system", retryable: false,
    nickname: `${nickname ?? payload.agent_id ?? "SE"} · command`, timestamp };
}

// Appends or updates only the active SE conversation and ignores replayed identities.
// Replayed older snapshots cannot replace the newer ordered text and command blocks.
export function appendSystemEngineerConversationEvent(messages, event, conversationId, nickname) {
  if (event.event_type !== "agent.activity" || !conversationId || event.payload?.conversation_id !== conversationId) return messages;
  const message = systemEngineerConversationEvent({ id: event.event_id, payload: event.payload, timestamp: event.timestamp }, nickname);
  if (!message) return messages;
  const position = messages.findIndex((entry) => entry.stream_key === message.stream_key);
  if (position < 0) return withoutSystemEngineerReplyDuplicates([...messages, message]);
  const previous = messages[position];
  if (previous.id === message.id || previous.sdk_sequence >= message.sdk_sequence) return messages;
  const next = [...messages];
  next[position] = { ...message, timestamp: previous.timestamp };
  return withoutSystemEngineerReplyDuplicates(next);
}

// Hides only duplicate merged reply text already present in public SE SDK messages.
// Keep fallback replies if a provider did not emit their text as public SDK events.
export function withoutSystemEngineerReplyDuplicates(messages) {
  const texts = new Map();
  for (const message of messages) {
    if (!message.se_text || !message.correlation_id) continue;
    const current = texts.get(message.correlation_id) ?? [];
    if (message.se_event?.type === "result" && current.includes(message.se_text)) continue;
    current.push(message.se_text);
    texts.set(message.correlation_id, current);
  }
  return messages.filter((message) => {
    const correlationId = message.correlation_id ?? (message.stream_key?.startsWith("agent:") ? message.stream_key.slice(6) : undefined);
    const candidates = texts.get(correlationId);
    return Boolean(message.se_event) || message.from !== "agent" || !candidates || ![...candidates, candidates.join(""), candidates.join("\n")].includes(message.text);
  });
}
