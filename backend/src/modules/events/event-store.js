// In-memory event store with idempotent append and duplicate-conflict detection.
import { ConfigurationError } from "../../shared/errors.js";
import { createPersistentEventStore } from "./persistent-event-store.js";

export class EventIdConflictError extends ConfigurationError {
  constructor(eventId) {
    super(`Event ID conflict: ${eventId} already belongs to different event content.`);
    this.name = "EventIdConflictError";
    this.code = "EVENT_ID_CONFLICT";
  }
}

// Creates an in-memory event store with idempotent duplicate handling.
export function createEventStore({ database } = {}) {
  if (database) return createPersistentEventStore({ database });
  const events = [];
  const eventsById = new Map();

  return Object.freeze({ append, getById, getAll, getByType });

  // Appends an event or returns a duplicate result if content matches.
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

  // Returns an event by its event_id.
  function getById(eventId) {
    if (typeof eventId !== "string" || eventId.length === 0) throw new ConfigurationError("An event_id is required.");
    const event = eventsById.get(eventId);
    return event ? cloneRecord(event) : undefined;
  }

  // Returns all stored events in order.
  function getAll() {
    return events.map(cloneRecord);
  }

  // Returns events filtered by event_type.
  function getByType(eventType) {
    if (typeof eventType !== "string" || eventType.length === 0) throw new ConfigurationError("An event_type is required.");
    return events.filter((event) => event.event_type === eventType).map(cloneRecord);
  }
}

// Validates required event fields before storage.
function assertEventRecord(event) {
  if (!event || typeof event !== "object" || typeof event.event_id !== "string" || event.event_id.length === 0
    || typeof event.event_type !== "string" || event.event_type.length === 0 || typeof event.timestamp !== "string"
    || typeof event.source !== "string" || event.source.length === 0 || !event.payload || typeof event.payload !== "object"
    || typeof event.project_id !== "string" || event.project_id.length === 0
    || !event.metadata || typeof event.metadata !== "object") {
    throw new ConfigurationError("Event Store requires event_id, event_type, project_id, timestamp, source, payload, and metadata.");
  }
}

// Fills project_id from metadata when missing.
function normalizeEvent(event) {
  return { ...event, ...(event?.project_id ? {} : { project_id: event?.metadata?.project_id }) };
}

// Freezes a normalized event into an immutable record.
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

// Clones a stored event into a mutable copy.
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

// Checks whether two records are byte-identical.
function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
