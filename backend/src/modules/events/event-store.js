import { ConfigurationError } from "../../shared/errors.js";
import { createPersistentEventStore } from "./persistent-event-store.js";

export class EventIdConflictError extends ConfigurationError {
  constructor(eventId) {
    super(`Event ID conflict: ${eventId} already belongs to different event content.`);
    this.name = "EventIdConflictError";
    this.code = "EVENT_ID_CONFLICT";
  }
}

export function createEventStore({ database } = {}) {
  if (database) return createPersistentEventStore({ database });
  const events = [];
  const eventsById = new Map();

  return Object.freeze({ append, getById, getAll, getByType });

  function append(event) {
    const normalized = normalizeEvent(event);
    assertEventRecord(normalized);
    const stored = freezeRecord(normalized);
    const existing = eventsById.get(stored.event_id);
    if (existing) {
      if (!sameRecord(existing, stored)) {
        throw new EventIdConflictError(stored.event_id);
      }
      return Object.freeze({ accepted: false, reason: "duplicate_event_id", event: cloneRecord(existing) });
    }
    events.push(stored);
    eventsById.set(stored.event_id, stored);
    return Object.freeze({ accepted: true, event: cloneRecord(stored) });
  }

  function getById(eventId) {
    if (typeof eventId !== "string" || eventId.length === 0) throw new ConfigurationError("An event_id is required.");
    const event = eventsById.get(eventId);
    return event ? cloneRecord(event) : undefined;
  }

  function getAll() {
    return events.map(cloneRecord);
  }

  function getByType(eventType) {
    if (typeof eventType !== "string" || eventType.length === 0) throw new ConfigurationError("An event_type is required.");
    return events.filter((event) => event.event_type === eventType).map(cloneRecord);
  }
}

function assertEventRecord(event) {
  if (!event || typeof event !== "object" || typeof event.event_id !== "string" || event.event_id.length === 0
    || typeof event.event_type !== "string" || event.event_type.length === 0 || typeof event.timestamp !== "string"
    || typeof event.source !== "string" || event.source.length === 0 || !event.payload || typeof event.payload !== "object"
    || typeof event.project_id !== "string" || event.project_id.length === 0
    || !event.metadata || typeof event.metadata !== "object") {
    throw new ConfigurationError("Event Store requires event_id, event_type, project_id, timestamp, source, payload, and metadata.");
  }
}

function normalizeEvent(event) {
  return { ...event, ...(event?.project_id ? {} : { project_id: event?.metadata?.project_id }) };
}

function freezeRecord(event) {
  return Object.freeze({
    event_id: event.event_id,
    project_id: event.project_id,
    event_type: event.event_type,
    timestamp: event.timestamp,
    source: event.source,
    payload: Object.freeze({ ...event.payload }),
    metadata: Object.freeze({ ...event.metadata })
  });
}

function cloneRecord(event) {
  return {
    event_id: event.event_id,
    project_id: event.project_id,
    event_type: event.event_type,
    timestamp: event.timestamp,
    source: event.source,
    payload: { ...event.payload },
    metadata: { ...event.metadata }
  };
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
