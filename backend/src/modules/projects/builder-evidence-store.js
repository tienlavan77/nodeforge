import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const builderEvidenceSchema = require("../../../../schemas/project/builder-evidence.schema.json");

export function createBuilderEvidenceId() {
  return `EVIDENCE-${randomUUID()}`;
}

export function createBuilderEvidenceStore({ database, projectId, taskStore, sessionStore, createId = createBuilderEvidenceId, clock = () => new Date() } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("A SQLite database is required for Builder evidence persistence.");
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required for Builder evidence persistence.");
  if (typeof taskStore?.get !== "function" || typeof sessionStore?.get !== "function") {
    throw new ConfigurationError("Builder evidence requires task and session stores.");
  }
  if (typeof createId !== "function" || typeof clock !== "function") throw new ConfigurationError("Builder evidence dependencies must be functions.");
  ensureEvidenceTable(database);

  function record({ taskId, sessionId, builderId, evidenceType, payload, reference, metadata } = {}) {
    const task = taskStore.get(taskId);
    if (!task) throw new ConfigurationError("Builder evidence task does not exist.");
    const session = sessionStore.get(sessionId);
    if (!session) throw new ConfigurationError("Builder evidence session does not exist.");
    if (session.task_id !== task.id) throw new ConfigurationError("Builder evidence session does not belong to the task.");
    if (!session.agents?.includes(builderId)) throw new ConfigurationError("Builder evidence Builder is not part of the session.");

    const evidence = {
      id: createId(),
      project_id: projectId,
      task_id: task.id,
      session_id: session.id,
      builder_id: builderId,
      evidence_type: evidenceType,
      created_at: clock().toISOString()
    };
    if (payload !== undefined) evidence.payload = payload;
    if (reference !== undefined) evidence.reference = reference;
    if (metadata !== undefined) evidence.metadata = metadata;
    validateEvidence(evidence);
    database.run(
      "INSERT INTO builder_evidence (evidence_id, project_id, task_id, session_id, builder_id, evidence_json) VALUES (?, ?, ?, ?, ?, ?)",
      [evidence.id, projectId, task.id, session.id, builderId, JSON.stringify(evidence)]
    );
    return Object.freeze({ ...evidence });
  }

  function byTask(taskId) {
    return readMany("SELECT evidence_json FROM builder_evidence WHERE task_id = ? AND project_id = ? ORDER BY created_at", [taskId, projectId]);
  }

  function bySession(sessionId) {
    return readMany("SELECT evidence_json FROM builder_evidence WHERE session_id = ? AND project_id = ? ORDER BY created_at", [sessionId, projectId]);
  }

  function readMany(sql, parameters) {
    return Object.freeze(database.all(sql, parameters).map(({ evidence_json: json }) => {
      const evidence = JSON.parse(json);
      validateEvidence(evidence);
      return Object.freeze(evidence);
    }));
  }

  return Object.freeze({ record, byTask, bySession });
}

function ensureEvidenceTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS builder_evidence (
    evidence_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    builder_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evidence_json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS builder_evidence_by_task ON builder_evidence (project_id, task_id)");
  database.run("CREATE INDEX IF NOT EXISTS builder_evidence_by_session ON builder_evidence (project_id, session_id)");
}

function validateEvidence(evidence) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(builderEvidenceSchema);
  const validate = ajv.getSchema(builderEvidenceSchema.$id);
  if (!validate(evidence)) {
    throw new ConfigurationError(`Invalid Builder evidence: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}
