// SQLite-backed event store that persists sequenced events with duplicate-conflict handling.
import { ConfigurationError } from "../../shared/errors.js";
import { EventIdConflictError } from "./event-store.js";

// Creates a SQLite-backed event store with auto-sequencing and duplicate checks.
export function createPersistentEventStore({ database } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("Persistent Event Store requires a SQLite database.");
  ensureEventTable(database);
  const events = [];
  const eventsById = new Map();

  load();

  return Object.freeze({ append, getById, getAll, getByType, load });

  // Persists an event to SQLite, assigning a sequence number.
  function append(event) {
    const normalized = normalizeEvent(event);
    assertEventRecord(normalized);
    const stored = freezeRecord(normalized);
    const existing = eventsById.get(stored.event_id);
    if (existing) {
      if (!sameRecord(existing, stored)) throw new EventIdConflictError(stored.event_id);
      return Object.freeze({ accepted: false, reason: "duplicate_event_id", event: cloneRecord(existing) });
    }
    events.push(stored);
    eventsById.set(stored.event_id, stored);
    try {
      const insertResult = database.run(
        "INSERT INTO events (event_id, project_id, event_type, timestamp, source, event_json) VALUES (?, ?, ?, ?, ?, ?)",
        [stored.event_id, stored.project_id, stored.event_type, stored.timestamp, stored.source, JSON.stringify(stored)]
      );
      const sequence = Number(insertResult?.lastInsertRowid);
      const sequenced = freezeRecord({ ...stored, sequence });
      events[events.length - 1] = sequenced;
      eventsById.set(sequenced.event_id, sequenced);
      return Object.freeze({ accepted: true, event: cloneRecord(sequenced) });
    } catch (error) {
      events.pop();
      eventsById.delete(stored.event_id);
      throw error;
    }
  }

  // Retrieves an event by its identifier.
  function getById(eventId) {
    if (typeof eventId !== "string" || eventId.length === 0) throw new ConfigurationError("An event_id is required.");
    const event = eventsById.get(eventId);
    return event ? cloneRecord(event) : undefined;
  }

  // Returns all events ordered by sequence.
  function getAll() {
    return events.map(cloneRecord);
  }

  // Returns events filtered by type.
  function getByType(eventType) {
    if (typeof eventType !== "string" || eventType.length === 0) throw new ConfigurationError("An event_type is required.");
    return events.filter((event) => event.event_type === eventType).map(cloneRecord);
  }

  // Reloads all events from the database into memory.
  function load() {
    events.splice(0, events.length);
    eventsById.clear();
    for (const { event_json: json, sequence, project_id: projectId } of database.all("SELECT event_json, sequence, project_id FROM events ORDER BY sequence")) {
      const parsed = JSON.parse(json);
      const event = freezeRecord({ ...parsed, project_id: parsed.project_id ?? projectId, sequence });
      events.push(event);
      eventsById.set(event.event_id, event);
    }
    return getAll();
  }
}

// Creates the events table and adds missing columns.
function ensureEventTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  const columns = database.all("PRAGMA table_info(events)").map(({ name }) => name);
  if (!columns.includes("project_id")) database.run("ALTER TABLE events ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
  database.run("CREATE INDEX IF NOT EXISTS events_by_type ON events (event_type, sequence)");
}

// Validates required event fields.
function assertEventRecord(event) {
  if (!event || typeof event !== "object" || typeof event.event_id !== "string" || event.event_id.length === 0
    || typeof event.event_type !== "string" || event.event_type.length === 0 || typeof event.timestamp !== "string"
    || typeof event.source !== "string" || event.source.length === 0 || !event.payload || typeof event.payload !== "object"
    || typeof event.project_id !== "string" || event.project_id.length === 0
    || !event.metadata || typeof event.metadata !== "object") {
    throw new ConfigurationError("Event Store requires event_id, event_type, project_id, timestamp, source, payload, and metadata.");
  }
}

// Fills project_id from metadata when absent.
function normalizeEvent(event) {
  return { ...event, ...(event?.project_id ? {} : { project_id: event?.metadata?.project_id }) };
}

// Freezes an event into an immutable record with optional sequence.
function freezeRecord(event) {
  return Object.freeze({
    event_id: event.event_id,
    project_id: event.project_id,
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    event_type: event.event_type,
    timestamp: event.timestamp,
    source: event.source,
    ...(event.task_id ? { task_id: event.task_id } : {}),
    ...(event.supervisor_id ? { supervisor_id: event.supervisor_id } : {}),
    ...(event.request_id ? { request_id: event.request_id } : {}),
    ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    ...(Number.isInteger(event.attempt) ? { attempt: event.attempt } : {}),
    payload: Object.freeze({ ...event.payload }),
    metadata: Object.freeze({ ...event.metadata })
  });
}

// Clones a stored event for return to callers.
function cloneRecord(event) {
  return {
    event_id: event.event_id,
    project_id: event.project_id,
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    event_type: event.event_type,
    timestamp: event.timestamp,
    source: event.source,
    ...(event.task_id ? { task_id: event.task_id } : {}),
    ...(event.supervisor_id ? { supervisor_id: event.supervisor_id } : {}),
    ...(event.request_id ? { request_id: event.request_id } : {}),
    ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    ...(Number.isInteger(event.attempt) ? { attempt: event.attempt } : {}),
    payload: { ...event.payload },
    metadata: { ...event.metadata }
  };
}

// Compares two records ignoring sequence.
function sameRecord(left, right) {
  const comparable = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== "sequence"));
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}
