// Persists and queries conversation records with UUID validation.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

const UPDATABLE = new Set(["title", "status"]);
const STATUSES = new Set(["active", "archived", "closed"]);

// Creates a CRUD service for conversation persistence.
export function createConversationCrudService({ database, clock = () => new Date() } = {}) {
  if (typeof database?.all !== "function" || typeof database?.run !== "function") throw new ConfigurationError("Conversation CRUD requires a database.");
  ensureTable(database);
  return Object.freeze({ list, create, get, update, remove, ensure });
  function ensure({ id, project_id: projectId, agent_id: agentId, title } = {}) {
    const existing = get(id);
    if (existing) return existing;
    return create({ id, project_id: projectId, agent_id: agentId, title });
  }
  function list({ projectId, agentId } = {}) {
    const where = []; const params = [];
    if (projectId !== undefined) { requireId(projectId, "project_id"); where.push("project_id = ?"); params.push(projectId); }
    if (agentId !== undefined) { requireId(agentId, "agent_id"); where.push("agent_id = ?"); params.push(agentId); }
    return database.all(`SELECT id, project_id, agent_id, title, status, created_at, updated_at FROM conversations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`, params);
  }
  function create(input = {}) {
    const projectId = requireId(input.project_id, "project_id");
    const agentId = requireId(input.agent_id, "agent_id");
    const now = clock().toISOString();
    let conversationId;
    if (input.id !== undefined && input.id !== null) conversationId = requireUuid(String(input.id), "id");
    else conversationId = randomUUID();
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw Object.assign(new ConfigurationError("title is required."), { statusCode: 400 });
    // Conversation creation is deliberately explicit about the three required request fields.
    // This keeps the POST contract aligned with the frontend modal and prevents an
    // accidentally generated conversation from being detached from its context.
    if (!Object.prototype.hasOwnProperty.call(input, "project_id") || !Object.prototype.hasOwnProperty.call(input, "agent_id")) {
      throw Object.assign(new ConfigurationError("project_id and agent_id are required."), { statusCode: 400 });
    }
    const conversation = { id: conversationId, project_id: projectId, agent_id: agentId, title, status: input.status ?? "active", created_at: now, updated_at: now };
    validateStatus(conversation.status);
    try { database.run("INSERT INTO conversations (id, project_id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", Object.values(conversation)); }
    catch (error) { if (String(error.message).includes("UNIQUE")) throw Object.assign(new ConfigurationError(`Conversation already exists: ${conversation.id}.`), { statusCode: 409 }); throw error; }
    return conversation;
  }
  function get(id) { const normalized = requireId(id, "conversation_id"); return database.all("SELECT id, project_id, agent_id, title, status, created_at, updated_at FROM conversations WHERE id = ?", [normalized])[0] ?? null; }
  function update(id, patch = {}) {
    const current = get(id); if (!current) throw Object.assign(new ConfigurationError(`Conversation not found: ${id}.`), { statusCode: 404 });
    const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => UPDATABLE.has(key) && value !== undefined));
    if (changes.status !== undefined) validateStatus(changes.status);
    if (changes.title !== undefined) changes.title = String(changes.title).trim() || current.title;
    const updated = { ...current, ...changes, updated_at: clock().toISOString() };
    database.run("UPDATE conversations SET title = ?, status = ?, updated_at = ? WHERE id = ?", [updated.title, updated.status, updated.updated_at, id]);
    return updated;
  }
  function remove(id) { const current = get(id); if (!current) throw Object.assign(new ConfigurationError(`Conversation not found: ${id}.`), { statusCode: 404 }); database.run("DELETE FROM conversations WHERE id = ?", [id]); return { deleted: true, conversation_id: id }; }
}

// Ensures the conversations table and indexes exist.
function ensureTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  database.run("CREATE INDEX IF NOT EXISTS conversations_project_agent ON conversations (project_id, agent_id, updated_at)");
  database.run("CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project_id, updated_at)");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Checks whether a value is a UUID.
function isUuid(value) { return typeof value === "string" && UUID_RE.test(value.trim()); }

// Migrates legacy conversation IDs to UUID format.
export function migrateConversationsToUuid(database) {
  if (typeof database?.all !== "function" || typeof database?.run !== "function") throw new ConfigurationError("Conversation migration requires a database.");
  ensureTable(database);
  const rows = database.all("SELECT id FROM conversations");
  let migrated = 0;
  for (const { id } of rows) {
    if (isUuid(id)) continue;
    const newId = randomUUID();
    database.run("UPDATE conversations SET id = ? WHERE id = ?", [newId, id]);
    migrated += 1;
  }
  return { migrated, total: rows.length };
}

// Validates that a required ID is a non-empty string.
function requireId(value, name) { if (typeof value !== "string" || !value.trim()) throw Object.assign(new ConfigurationError(`${name} is required.`), { statusCode: 400 }); return value.trim(); }
// Validates that a required ID is a valid UUID.
function requireUuid(value, name) { const trimmed = requireId(value, name); if (!isUuid(trimmed)) throw Object.assign(new ConfigurationError(`${name} must be a UUID v4.`), { statusCode: 400 }); return trimmed; }
// Validates conversation status values.
function validateStatus(value) { if (!STATUSES.has(value)) throw Object.assign(new ConfigurationError(`Invalid conversation status: ${value}.`), { statusCode: 400 }); }
