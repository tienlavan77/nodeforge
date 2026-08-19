import { ConfigurationError } from "../../shared/errors.js";

export function createAgentSessionStore({ database } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("Agent Session Store requires a SQLite database.");
  ensureSessionTable(database);

  return Object.freeze({ save, load, loadAll });

  function save(session) {
    if (typeof session?.getSnapshot !== "function") throw new ConfigurationError("Agent Session Store can only save an Agent Session.");
    const snapshot = session.getSnapshot();
    assertSnapshot(snapshot);
    database.run(
      `INSERT INTO agent_runtime_sessions (session_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      [snapshot.id, snapshot.state, snapshot.created_at, snapshot.updated_at]
    );
    return cloneSnapshot(snapshot);
  }

  function load(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new ConfigurationError("An Agent Session id is required.");
    const row = database.all("SELECT session_id, state, created_at, updated_at FROM agent_runtime_sessions WHERE session_id = ?", [sessionId])[0];
    return row ? snapshotFromRow(row) : undefined;
  }

  function loadAll() {
    return database.all("SELECT session_id, state, created_at, updated_at FROM agent_runtime_sessions ORDER BY rowid").map(snapshotFromRow);
  }
}

function ensureSessionTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.id !== "string" || snapshot.id.length === 0 || typeof snapshot.state !== "string" || snapshot.state.length === 0
    || typeof snapshot.created_at !== "string" || typeof snapshot.updated_at !== "string") {
    throw new ConfigurationError("Agent Session snapshot is invalid.");
  }
}

function snapshotFromRow({ session_id: id, state, created_at, updated_at }) {
  return Object.freeze({ id, state, created_at, updated_at });
}

function cloneSnapshot(snapshot) {
  return { ...snapshot };
}
