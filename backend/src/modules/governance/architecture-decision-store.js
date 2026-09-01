import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const decisionSchema = require("../../../../schemas/governance/architecture-decision.schema.json");

const SENSITIVE = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

export function createArchitectureDecisionStore({ validateDecision = createDecisionValidator(), database } = {}) {
  if (typeof validateDecision !== "function") throw new ConfigurationError("Architecture Decision validation must be a function.");
  if (database !== undefined && (!database?.run || !database?.all)) throw new ConfigurationError("Persistent Architecture Decision Store requires a SQLite database.");
  const decisions = [];
  const decisionsById = new Map();
  if (database) load();

  return Object.freeze({ append, getById, getAll, getByType, load });

  function append(decision) {
    validateDecision(decision);
    const id = decisionIdentity(decision);
    if (decisionsById.has(id)) throw new ConfigurationError(`Architecture Decision already exists: ${id}.`);
    const stored = freezeDecision(redact(decision));
    if (database) database.run("INSERT INTO governance_decisions (decision_id, decision_type, decision_json) VALUES (?, ?, ?)", [id, stored.type, JSON.stringify(stored)]);
    decisions.push(stored);
    decisionsById.set(id, stored);
    return cloneDecision(stored);
  }

  function getById(id) {
    if (typeof id !== "string" || id.length === 0) throw new ConfigurationError("An Architecture Decision id is required.");
    const decision = decisionsById.get(id);
    return decision ? cloneDecision(decision) : undefined;
  }

  function getAll() {
    return decisions.map(cloneDecision);
  }

  function getByType(type) {
    if (typeof type !== "string" || type.length === 0) throw new ConfigurationError("An Architecture Decision type is required.");
    return decisions.filter((decision) => decision.type === type).map(cloneDecision);
  }

  function load() {
    if (!database) return getAll();
    ensureTable(database);
    decisions.splice(0, decisions.length);
    decisionsById.clear();
    for (const { decision_json } of database.all("SELECT decision_json FROM governance_decisions ORDER BY sequence")) {
      const stored = freezeDecision(JSON.parse(decision_json));
      decisions.push(stored);
      decisionsById.set(decisionIdentity(stored), stored);
    }
    return getAll();
  }
}

function decisionIdentity(decision) {
  return decision.id ?? decision.decision_id;
}

function createDecisionValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(decisionSchema);
  const validate = ajv.getSchema(decisionSchema.$id);
  return (decision) => {
    if (!validate(decision)) throw new ConfigurationError(`Invalid Architecture Decision: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}

function freezeDecision(decision) {
  return Object.freeze(structuredClone(decision));
}

function cloneDecision(decision) {
  return structuredClone(decision);
}

function ensureTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS governance_decisions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL UNIQUE,
    decision_type TEXT NOT NULL,
    decision_json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS governance_decisions_type ON governance_decisions (decision_type, sequence)");
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(item)]));
}
