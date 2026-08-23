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

  function connect({ projectId, conversationId, response, afterMessageId, replayLimit = 100 } = {}) {
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
    const pending = [];
    let replaying = true;
    let closed = false;
    const observer = (message) => {
      if (message.project_id === projectId && message.conversation_id === conversationId) {
        if (replaying) pending.push(message);
        else write(message);
      }
    };
    bus.subscribeAll(observer);
    const eventSubscriptions = ["agent.*", "verification.result", "governance.sprint_plan.created"].map((eventType) => subscriptions?.subscribe?.(eventType, (event) => {
      if ((event.project_id ?? event.metadata?.project_id) === projectId && (event.metadata?.conversation_id ?? event.metadata?.task_id) === conversationId) {
        const message = eventMessage(event);
        if (replaying) pending.push(message);
        else write(message);
      }
    })).filter(Boolean);
    const replay = communicationStore.getByConversationId(conversationId)
      .filter((message) => message.project_id === projectId);
    const eventReplay = (eventStore?.getAll?.() ?? [])
      .filter((event) => (event.project_id ?? event.metadata?.project_id) === projectId && (event.metadata?.conversation_id ?? event.metadata?.task_id) === conversationId)
      .map(eventMessage);
    const replayMessages = [...replay.map(messageEnvelope), ...eventReplay].sort(compareStreamEvents);
    const cursorIndex = afterMessageId ? replayMessages.findIndex((message) => message.id === afterMessageId) : -1;
    const replayStart = afterMessageId && cursorIndex >= 0 ? cursorIndex + 1 : Math.max(0, replayMessages.length - normalizeLimit(replayLimit));
    for (const message of replayMessages.slice(replayStart)) write(message);
    response.write("event: conversation.replay.complete\ndata: {}\n\n");
    replaying = false;
    for (const message of pending.splice(0).sort(compareStreamEvents)) write(message);
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
      const eventName = event.message_type?.endsWith(".tool.result") ? "conversation.tool" : "conversation.message";
      response.write(`id: ${event.message_id}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
}

function normalizeLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
}

function compareStreamEvents(left, right) {
  const timestamp = String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""));
  if (timestamp !== 0) return timestamp;
  return (left.sequence ?? left.payload?.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? right.payload?.sequence ?? Number.MAX_SAFE_INTEGER);
}

function messageEnvelope(message) { return { ...message, _kind: "message" }; }
function eventMessage(event) {
  return { id: event.event_id, project_id: event.project_id ?? event.metadata?.project_id, conversation_id: event.metadata?.conversation_id ?? event.metadata?.task_id, correlation_id: event.metadata?.correlation_id ?? null, message_type: event.event_type, timestamp: event.timestamp, sender: { id: event.metadata?.agent_id ?? event.source, role: "node" }, recipient: { id: "NODE", role: "node" }, payload: event.payload, _kind: "event" };
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
