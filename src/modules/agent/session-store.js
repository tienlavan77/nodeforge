import { ConfigurationError } from "../../shared/errors.js";

export function createAgentSessionStore({ database } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("Agent Session Store requires a SQLite database.");
  ensureSessionTable(database);

  return Object.freeze({ save, load, loadAll });

  function save(session, metadata = {}) {
    if (typeof session?.getSnapshot !== "function") throw new ConfigurationError("Agent Session Store can only save an Agent Session.");
    const snapshot = session.getSnapshot();
    assertSnapshot(snapshot);
    database.run(
      `INSERT INTO agent_runtime_sessions (session_id, state, created_at, updated_at, agent_id, workflow_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at,
       agent_id = COALESCE(excluded.agent_id, agent_runtime_sessions.agent_id),
       workflow_id = COALESCE(excluded.workflow_id, agent_runtime_sessions.workflow_id),
       correlation_id = COALESCE(excluded.correlation_id, agent_runtime_sessions.correlation_id)`,
      [snapshot.id, snapshot.state, snapshot.created_at, snapshot.updated_at, metadata.agent_id ?? null, metadata.workflow_id ?? null, metadata.correlation_id ?? null]
    );
    return cloneSnapshot({ ...snapshot, ...optionalMetadata(metadata) });
  }

  function load(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new ConfigurationError("An Agent Session id is required.");
    const row = database.all("SELECT session_id, state, created_at, updated_at, agent_id, workflow_id, correlation_id FROM agent_runtime_sessions WHERE session_id = ?", [sessionId])[0];
    return row ? snapshotFromRow(row) : undefined;
  }

  function loadAll() {
    return database.all("SELECT session_id, state, created_at, updated_at, agent_id, workflow_id, correlation_id FROM agent_runtime_sessions ORDER BY rowid").map(snapshotFromRow);
  }
}

function ensureSessionTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    agent_id TEXT,
    workflow_id TEXT,
    correlation_id TEXT
  )`);
  const columns = new Set(database.all("PRAGMA table_info(agent_runtime_sessions)").map(({ name }) => name));
  for (const column of ["agent_id", "workflow_id", "correlation_id"]) {
    if (!columns.has(column)) database.run(`ALTER TABLE agent_runtime_sessions ADD COLUMN ${column} TEXT`);
  }
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.id !== "string" || snapshot.id.length === 0 || typeof snapshot.state !== "string" || snapshot.state.length === 0
    || typeof snapshot.created_at !== "string" || typeof snapshot.updated_at !== "string") {
    throw new ConfigurationError("Agent Session snapshot is invalid.");
  }
}

function snapshotFromRow({ session_id: id, state, created_at, updated_at, agent_id: agentId, workflow_id: workflowId, correlation_id: correlationId }) {
  return Object.freeze({ id, state, created_at, updated_at, ...optionalMetadata({ agent_id: agentId, workflow_id: workflowId, correlation_id: correlationId }) });
}

function cloneSnapshot(snapshot) {
  return { ...snapshot };
}

function optionalMetadata(metadata) {
  return Object.fromEntries(Object.entries({ agent_id: metadata.agent_id, workflow_id: metadata.workflow_id, correlation_id: metadata.correlation_id }).filter(([, value]) => value !== undefined && value !== null));
}
