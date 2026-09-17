// Provides project-scoped SSE streaming with watcher and conversation projection.
import { randomUUID } from "node:crypto";

import { ConfigurationError } from "../../shared/errors.js";
import { createProjectStreamPublisher } from "./project-stream-publisher.js";

const INDEX_EVENT_TYPES = new Set(["indexer.indexed", "watcher.indexed", "watcher.file_indexed", "watcher.file_created", "watcher.file_modified", "watcher.file_deleted", "watcher.file_renamed"]);
const PROJECT_EVENT_TYPES = new Set([...INDEX_EVENT_TYPES, "ticket.created", "ticket.updated", "ticket.status_change", "ticket.status_changed", "ticket.deleted", "ticket.creation", "sprint.created", "sprint.updated", "sprint.deleted", "conversation.message.delta", "conversation.message.received", "conversation.message.owner", "agent.text_stream", "agent.message.delta", "agent.message.received"]);

/** Project-scoped SSE projection for the initial stream contract. */
export function createProjectStream({ projectId, indexDb, watcherSnapshot, subscriptions, eventBus, bus, heartbeatMs = 15000, clock = () => new Date().toISOString() } = {}) {
  if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("Project SSE requires a project id.");
  if (typeof indexDb?.all !== "function" && typeof watcherSnapshot?.snapshot !== "function") throw new ConfigurationError("Project SSE requires the Code Index database or Watcher Snapshot service.");
  if (typeof subscriptions?.subscribe !== "function" || typeof subscriptions?.unsubscribe !== "function") throw new ConfigurationError("Project SSE requires a Subscription Registry.");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000) throw new ConfigurationError("Project SSE heartbeat must be at least 1000ms.");
  const publisher = createProjectStreamPublisher({ projectId, indexDb: indexDb ?? { all: () => [] } });

  return Object.freeze({ connect, ingest });
  function ingest(event = {}) {
    const eventType = event.type ?? event.event_type;
    if (event.project_id !== projectId) throw Object.assign(new ConfigurationError("Project event belongs to a different project."), { statusCode: 409, code: "PROJECT_CONTEXT_CONFLICT" });
    if (!PROJECT_EVENT_TYPES.has(eventType)) throw Object.assign(new ConfigurationError("Unsupported project stream event."), { statusCode: 400, code: "STREAM_EVENT_NOT_SUPPORTED" });

    // Watcher runs in a separate process and sends a deliberately small event
    // envelope. Normalize it before publishing so wildcard subscribers (history,
    // audit, etc.) receive the same safe shape as native Node events.
    const normalized = {
      ...event,
      event_id: event.event_id ?? `EVT-${randomUUID()}`,
      event_type: eventType,
      timestamp: event.timestamp ?? clock(),
      source: event.source ?? "watcher",
      metadata: {
        ...(event.metadata ?? {}),
        source: event.metadata?.source ?? event.source ?? "watcher",
        project_id: event.metadata?.project_id ?? projectId
      },
      payload: event.payload && typeof event.payload === "object" ? event.payload : {}
    };
    const delivered = subscriptions.publish(normalized);
    return { accepted: true, event_id: normalized.event_id, delivered };
  }
  function connect({ requestedProjectId, response, afterEventId } = {}) {
    if (requestedProjectId !== projectId) throw Object.assign(new ConfigurationError("Project stream is not configured for this project."), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    if (!response?.write || typeof response.end !== "function") throw new ConfigurationError("Project SSE requires a writable response.");

    response.writeHead?.(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    let closed = false;
    let sequence = 0;
    const streamId = `STREAM-${randomUUID()}`;
    const seen = new Set();
    const write = (event) => {
      if (closed || seen.has(event.event_id) || response.writableEnded) return;
      seen.add(event.event_id);
      response.write(`id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const envelope = (eventType, payload, metadata = {}) => ({
      event_id: `EVT-${randomUUID()}`,
      event_type: eventType,
      schema_version: 1,
      project_id: projectId,
      timestamp: clock(),
      sequence: ++sequence,
      ...metadata,
      payload
    });

    write(envelope("stream.connected", { stream_id: streamId, replay_from: afterEventId ?? null }));
    const snapshot = watcherSnapshot?.snapshot?.() ?? { watcher: { recent_events: indexDb.all("SELECT path, language, size_bytes, sha256, indexed_at FROM files WHERE indexed_at IS NOT NULL ORDER BY indexed_at DESC LIMIT 4").map((file) => ({ event_id: `SNAPSHOT-${file.path}-${file.indexed_at}`, event_type: "watcher.file_indexed", timestamp: file.indexed_at, payload: { ...file, operation: "indexer.updated", activity: [`Filesystem change: ${file.path}`, `Watcher event: watcher.file_indexed ${file.path}`, `Indexer updated: ${file.path}`] } })) } };
    write(envelope("stream.snapshot", snapshot));

    const publish = (event) => {
      if (closed || !PROJECT_EVENT_TYPES.has(event?.event_type) && event?.event_type !== "watcher.indexed") return;
      const conversation = projectConversationEvent(event);
      if (conversation) {
        write(envelope(conversation.event_type, conversation.payload));
        return;
      }
      const projected = publisher.project(event);
      if (projected) write(envelope(projected.event_type, projected.payload));
    };
    const subscription = subscriptions.subscribe("*", publish);
    const onConversationMessage = (message) => {
      if (closed || message?.project_id !== projectId) return;
      const projected = projectConversationMessage(message);
      if (projected) write(envelope(projected.event_type, projected.payload));
    };
    bus?.subscribeAll?.(onConversationMessage);
    const onInternalEvent = (event) => publish({ ...event, event_type: "watcher.indexed", project_id: event.project_id ?? projectId });
    eventBus?.on?.("watcher.indexed", onInternalEvent);
    const conversationEventTypes = ["agent.text_stream", "agent.message.delta", "agent.message.received"];
    const conversationListeners = conversationEventTypes.map((eventType) => {
      const listener = (event) => publish({ ...event, event_type: event.event_type ?? eventType, project_id: event.project_id ?? event.metadata?.project_id ?? projectId });
      eventBus?.on?.(eventType, listener);
      return { eventType, listener };
    });
    const heartbeat = setInterval(() => {
      if (!closed && !response.writableEnded) response.write(": keep-alive\n\n");
    }, heartbeatMs);
    heartbeat.unref?.();

    return Object.freeze({
      close() {
        if (closed) return false;
        closed = true;
        clearInterval(heartbeat);
        subscriptions.unsubscribe(subscription);
        bus?.unsubscribeAll?.(onConversationMessage);
        eventBus?.off?.("watcher.indexed", onInternalEvent);
        for (const { eventType, listener } of conversationListeners) eventBus?.off?.(eventType, listener);
        if (!response.writableEnded) response.end();
        return true;
      }
    });
  }
}

// Projects a communication message to a project stream event.
function projectConversationMessage(message) {
  const type = String(message?.message_type ?? "");
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
  const eventType = type === "owner.message" ? "conversation.message.owner"
    : type.endsWith(".message.delta") ? "conversation.message.delta"
      : type.endsWith(".message.received") ? "conversation.message.received" : null;
  if (!eventType || typeof message?.conversation_id !== "string") return null;
  return {
    event_type: eventType,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      correlation_id: message.correlation_id ?? null,
      agent_id: message.sender?.id ?? null,
      sender_role: message.sender?.role ?? null,
      text: payload.text ?? null,
      chunk: payload.chunk ?? payload.text ?? null,
      done: eventType !== "conversation.message.delta"
    }
  };
}

// Projects a domain event to a conversation stream event.
function projectConversationEvent(event) {
  const type = String(event?.event_type ?? event?.type ?? "");
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const conversationId = payload.conversation_id ?? event?.metadata?.conversation_id;
  const eventType = type === "agent.message.received" ? "conversation.message.received"
    : type === "agent.text_stream" || type === "agent.message.delta" ? "conversation.message.delta" : null;
  if (!eventType || typeof event?.project_id !== "string" || typeof conversationId !== "string") return null;
  return {
    event_type: eventType,
    payload: {
      message_id: event.event_id ?? `EVENT-${event.task_id ?? "conversation"}-${event.timestamp}`,
      conversation_id: conversationId,
      correlation_id: payload.correlation_id ?? event.metadata?.correlation_id ?? event.task_id ?? null,
      agent_id: payload.agent_id ?? event.agent_id ?? event.metadata?.agent_id ?? null,
      sender_role: "agent",
      text: payload.text ?? null,
      chunk: payload.chunk ?? payload.text ?? null,
      done: eventType === "conversation.message.received" || payload.done === true
    }
  };
}
