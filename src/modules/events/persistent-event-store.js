import { ConfigurationError } from "../../shared/errors.js";
import { EventIdConflictError } from "./event-store.js";

export function createPersistentEventStore({ database } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("Persistent Event Store requires a SQLite database.");
  ensureEventTable(database);
  const events = [];
  const eventsById = new Map();

  load();

  return Object.freeze({ append, getById, getAll, getByType, load });

  function append(event) {
    assertEventRecord(event);
    const stored = freezeRecord(event);
    const existing = eventsById.get(stored.event_id);
    if (existing) {
      if (!sameRecord(existing, stored)) throw new EventIdConflictError(stored.event_id);
      return Object.freeze({ accepted: false, reason: "duplicate_event_id", event: cloneRecord(existing) });
    }
    database.run(
      "INSERT INTO events (event_id, event_type, timestamp, source, event_json) VALUES (?, ?, ?, ?, ?)",
      [stored.event_id, stored.event_type, stored.timestamp, stored.source, JSON.stringify(stored)]
    );
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

  function load() {
    events.splice(0, events.length);
    eventsById.clear();
    for (const { event_json: json } of database.all("SELECT event_json FROM events ORDER BY sequence")) {
      const event = freezeRecord(JSON.parse(json));
      events.push(event);
      eventsById.set(event.event_id, event);
    }
    return getAll();
  }
}

function ensureEventTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS events_by_type ON events (event_type, sequence)");
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

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
