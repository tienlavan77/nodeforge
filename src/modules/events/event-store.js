import { ConfigurationError } from "../../shared/errors.js";

export function createEventStore() {
  const events = [];

  return Object.freeze({ append, getById, getAll, getByType });

  function append(event) {
    assertEventRecord(event);
    const stored = freezeRecord(event);
    events.push(stored);
    return cloneRecord(stored);
  }

  function getById(eventId) {
    if (typeof eventId !== "string" || eventId.length === 0) throw new ConfigurationError("An event_id is required.");
    const event = events.find((candidate) => candidate.event_id === eventId);
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
    || !event.metadata || typeof event.metadata !== "object") {
    throw new ConfigurationError("Event Store requires event_id, event_type, timestamp, source, payload, and metadata.");
  }
}

function freezeRecord(event) {
  return Object.freeze({
    event_id: event.event_id,
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
    event_type: event.event_type,
    timestamp: event.timestamp,
    source: event.source,
    payload: { ...event.payload },
    metadata: { ...event.metadata }
  };
}
