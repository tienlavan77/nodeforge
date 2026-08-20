import { ConfigurationError } from "../../shared/errors.js";

// This is a transport projection: communications remain canonical in the Node store.
export function createConversationStream({ bus, communicationStore, eventStore, subscriptions } = {}) {
  if (typeof bus?.subscribeAll !== "function" || typeof bus?.unsubscribeAll !== "function") {
    throw new ConfigurationError("Conversation SSE requires the shared Communication Bus.");
  }
  if (typeof communicationStore?.getByConversationId !== "function") {
    throw new ConfigurationError("Conversation SSE requires the Communication Store.");
  }

  return Object.freeze({ connect });

  function connect({ projectId, conversationId, response, afterMessageId } = {}) {
    assertId(projectId, "project");
    assertId(conversationId, "conversation");
    if (!response?.write || typeof response.end !== "function") throw new ConfigurationError("Conversation SSE requires a writable response.");
    response.writeHead?.(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const seen = new Set();
    const replay = communicationStore.getByConversationId(conversationId)
      .filter((message) => message.project_id === projectId);
    const eventReplay = (eventStore?.getAll?.() ?? [])
      .filter((event) => event.metadata?.project_id === projectId && (event.metadata?.conversation_id ?? event.metadata?.task_id) === conversationId)
      .map(eventMessage);
    const replayMessages = [...replay.map(messageEnvelope), ...eventReplay].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const replayStart = afterMessageId ? Math.max(0, replayMessages.findIndex((message) => message.id === afterMessageId) + 1) : 0;
    for (const message of replayMessages.slice(replayStart)) write(message);

    const observer = (message) => {
      if (message.project_id === projectId && message.conversation_id === conversationId) write(message);
    };
    bus.subscribeAll(observer);
    const eventSubscriptions = ["agent.*", "verification.result"].map((eventType) => subscriptions?.subscribe?.(eventType, (event) => {
      if (event.metadata?.project_id === projectId && (event.metadata?.conversation_id ?? event.metadata?.task_id) === conversationId) write(eventMessage(event));
    })).filter(Boolean);
    let closed = false;
    return Object.freeze({
      close() {
        if (closed) return false;
        closed = true;
        bus.unsubscribeAll(observer);
        for (const eventSubscription of eventSubscriptions) subscriptions.unsubscribe(eventSubscription);
        response.end();
        return true;
      }
    });

    function write(message) {
      if (seen.has(message.id)) return;
      seen.add(message.id);
      const event = normalize(message);
      response.write(`id: ${event.message_id}\nevent: conversation.message\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
}

function messageEnvelope(message) { return { ...message, _kind: "message" }; }
function eventMessage(event) {
  return { id: event.event_id, project_id: event.metadata?.project_id, conversation_id: event.metadata?.conversation_id ?? event.metadata?.task_id, correlation_id: event.metadata?.correlation_id ?? null, message_type: event.event_type, timestamp: event.timestamp, sender: { id: event.metadata?.agent_id ?? event.source, role: "node" }, recipient: { id: "NODE", role: "node" }, payload: event.payload, _kind: "event" };
}

function normalize(message) {
  return {
    message_id: message.id,
    agent_id: message.sender.id,
    conversation_id: message.conversation_id,
    correlation_id: message.correlation_id,
    message_type: message.message_type,
    project_id: message.project_id,
    sender: structuredClone(message.sender),
    timestamp: message.timestamp,
    payload: structuredClone(message.payload)
  };
}

function assertId(value, subject) {
  if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`Conversation SSE ${subject} id is required.`);
}
