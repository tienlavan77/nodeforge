import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const agentSchema = require("../../../schemas/core/agent.schema.json");
const sessionSchema = require("../../../schemas/project/session.schema.json");
const CLOSED_STATUSES = new Set(["completed", "failed", "cancelled", "timeout"]);

export function createSessionId() {
  return `SESSION-${randomUUID()}`;
}

export function createSessionStore({ database, projectId, createId = createSessionId, clock = () => new Date() } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("A SQLite database is required for session persistence.");
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required for session persistence.");

  ensureSessionTable(database);

  function get(sessionId) {
    const row = database.all("SELECT session_json FROM project_sessions WHERE session_id = ? AND project_id = ?", [sessionId, projectId])[0];
    if (!row) return undefined;
    const session = JSON.parse(row.session_json);
    validateSession(session);
    return Object.freeze(session);
  }

  return Object.freeze({
    create({ taskId, workflowRunId, startedBy, agents, capabilityScopes, metadata } = {}) {
      const session = {
        id: createId(),
        project_id: projectId,
        status: "active",
        started_at: clock().toISOString()
      };
      if (taskId !== undefined) session.task_id = taskId;
      if (workflowRunId !== undefined) session.workflow_run_id = workflowRunId;
      if (startedBy !== undefined) session.started_by = startedBy;
      if (agents !== undefined) session.agents = agents;
      if (capabilityScopes !== undefined) session.capability_scopes = capabilityScopes;
      if (metadata !== undefined) session.metadata = metadata;
      validateSession(session);

      database.run(
        "INSERT INTO project_sessions (session_id, project_id, status, started_at, finished_at, session_json) VALUES (?, ?, ?, ?, ?, ?)",
        [session.id, projectId, session.status, session.started_at, null, JSON.stringify(session)]
      );
      return Object.freeze({ ...session });
    },
    get,
    close(sessionId, { status = "completed", finishedAt = clock().toISOString(), summary } = {}) {
      if (!CLOSED_STATUSES.has(status)) throw new ConfigurationError("A closed session must have a terminal status.");
      const existing = get(sessionId);
      if (!existing) return undefined;

      const session = { ...existing, status, finished_at: finishedAt };
      if (summary !== undefined) session.summary = summary;
      validateSession(session);
      database.run(
        "UPDATE project_sessions SET status = ?, finished_at = ?, session_json = ? WHERE session_id = ? AND project_id = ?",
        [session.status, session.finished_at, JSON.stringify(session), session.id, projectId]
      );
      return Object.freeze(session);
    }
  });
}

function ensureSessionTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS project_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    session_json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS project_sessions_by_project ON project_sessions (project_id)");
}

function validateSession(session) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(agentSchema).addSchema(sessionSchema);
  const validate = ajv.getSchema(sessionSchema.$id);
  if (!validate(session)) {
    throw new ConfigurationError(`Invalid session record: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}
