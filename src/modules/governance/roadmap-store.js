import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const roadmapSchema = require("../../../schemas/governance/roadmap.schema.json");
const sprintPlanSchema = require("../../../schemas/governance/sprint-plan.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");

const SENSITIVE = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

export function createRoadmapStore({ validateRoadmap = createRoadmapValidator(), database } = {}) {
  if (typeof validateRoadmap !== "function") throw new ConfigurationError("Roadmap validation must be a function.");
  if (database !== undefined && (!database?.run || !database?.all)) throw new ConfigurationError("Persistent Roadmap Store requires a SQLite database.");
  const versions = [];
  const byVersion = new Map();
  if (database) load();

  return Object.freeze({ save, getCurrent, getVersion, getAllVersions, load });

  function save(roadmap) {
    validateRoadmap(roadmap);
    if (byVersion.has(roadmap.version)) throw new ConfigurationError(`Roadmap version already exists: ${roadmap.version}.`);
    const stored = Object.freeze(redact(structuredClone(roadmap)));
    if (database) database.run("INSERT INTO governance_roadmaps (version, roadmap_json) VALUES (?, ?)", [stored.version, JSON.stringify(stored)]);
    versions.push(stored);
    byVersion.set(stored.version, stored);
    return structuredClone(stored);
  }

  function getCurrent() {
    return versions.length > 0 ? structuredClone(versions.at(-1)) : undefined;
  }

  function getVersion(version) {
    if (typeof version !== "string" || version.length === 0) throw new ConfigurationError("A roadmap version is required.");
    const roadmap = byVersion.get(version);
    return roadmap ? structuredClone(roadmap) : undefined;
  }

  function getAllVersions() {
    return versions.map((roadmap) => structuredClone(roadmap));
  }

  function load() {
    if (!database) return getAllVersions();
    ensureTable(database);
    versions.splice(0, versions.length);
    byVersion.clear();
    for (const { roadmap_json } of database.all("SELECT roadmap_json FROM governance_roadmaps ORDER BY sequence")) {
      const stored = Object.freeze(JSON.parse(roadmap_json));
      versions.push(stored);
      byVersion.set(stored.version, stored);
    }
    return getAllVersions();
  }
}

function ensureTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS governance_roadmaps (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    roadmap_json TEXT NOT NULL
  )`);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(item)]));
}

function createRoadmapValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema).addSchema(sprintPlanSchema).addSchema(roadmapSchema);
  const validate = ajv.getSchema(roadmapSchema.$id);
  return (roadmap) => {
    if (!validate(roadmap)) throw new ConfigurationError(`Invalid Roadmap: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}
