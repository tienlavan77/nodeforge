// Versioned roadmap store with ticket mutation helpers and schema validation.
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const roadmapSchema = require("../../../../schemas/governance/roadmap.schema.json");
const sprintPlanSchema = require("../../../../schemas/governance/sprint-plan.schema.json");
const ticketSchema = require("../../../../schemas/governance/ticket.schema.json");

const SENSITIVE = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

// Creates a versioned roadmap store with ticket and sprint helpers.
export function createRoadmapStore({ validateRoadmap = createRoadmapValidator(), validateTicket: validateTicketSchema = createTicketValidator(), database } = {}) {
  if (typeof validateRoadmap !== "function") throw new ConfigurationError("Roadmap validation must be a function.");
  if (typeof validateTicketSchema !== "function") throw new ConfigurationError("Ticket validation must be a function.");
  if (database !== undefined && (!database?.run || !database?.all)) throw new ConfigurationError("Persistent Roadmap Store requires a SQLite database.");
  const versions = [];
  const byVersion = new Map();
  if (database) load();

  return Object.freeze({ save, updateTicketStatus, updateTicket, removeSprint, removeTicket, getCurrent, getVersion, getAllVersions, load });

  // Creates a new roadmap version with an updated ticket status.
  function updateTicketStatus({ projectId, ticketId, status, error } = {}) {
    if (!projectId || !ticketId || !["pending", "running", "reviewing", "done", "failed", "needs_human_review"].includes(status)) throw new ConfigurationError("A valid project, ticket, and status are required.");
    const current = getCurrent();
    if (!current || current.project_id !== projectId) return undefined;
    let found = false;
    const sprints = current.sprints.map((sprint) => ({ ...sprint, tickets: (sprint.tickets ?? []).map((ticket) => {
      if (ticket.id !== ticketId) return ticket;
      found = true;
      return { ...ticket, status, ...(error ? { last_error: error } : {}) };
    }) }));
    if (!found) return undefined;
    const version = `${current.version}-status-${Date.now()}`;
    return save({ ...current, version, updated_at: new Date().toISOString(), sprints });
  }

  // Patches whitelisted ticket fields and creates a new roadmap version.
  function updateTicket({ projectId, ticketId, patch } = {}) {
    if (!projectId || !ticketId || !patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConfigurationError("A valid project, ticket, and patch are required.");
    const assignable = ["title", "objective", "acceptance_criteria", "priority", "dependencies", "status", "last_error"].filter((field) => patch[field] !== undefined);
    if (!assignable.length) throw new ConfigurationError("No updatable ticket fields provided.");
    const current = getCurrent();
    if (!current || current.project_id !== projectId) return undefined;
    let found = false;
    const sprints = current.sprints.map((sprint) => ({ ...sprint, tickets: (sprint.tickets ?? []).map((ticket) => {
      if (ticket.id !== ticketId || ticket.project_id !== projectId) return ticket;
      found = true;
      return { ...ticket, ...Object.fromEntries(assignable.map((field) => [field, patch[field]])) };
    }) }));
    if (!found) return undefined;
    const merged = sprints.flatMap((sprint) => sprint.tickets ?? []).find((ticket) => ticket.id === ticketId);
    if (!validateTicketSchema(merged)) throw new ConfigurationError(`Invalid Ticket: ${ajvErrorsText(validateTicketSchema)}`);
    const version = `${current.version}-update-${Date.now()}`;
    return save({ ...current, version, updated_at: new Date().toISOString(), sprints });
  }

  // Removes a sprint from all versions and creates updated successors.
  function removeSprint(projectId, sprintId) {
    let removed = false;
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const roadmap = versions[index];
      if (roadmap.project_id !== projectId || !roadmap.sprints?.some((sprint) => sprint.id === sprintId)) continue;
      const remaining = roadmap.sprints.filter((sprint) => sprint.id !== sprintId);
      if (remaining.length === roadmap.sprints.length) continue;
      if (database) database.run("DELETE FROM governance_roadmaps WHERE version = ?", [roadmap.version]);
      versions.splice(index, 1); byVersion.delete(roadmap.version); removed = true;
      if (remaining.length) {
        const updated = { ...roadmap, sprints: remaining, updated_at: new Date().toISOString(), version: `${roadmap.version}-updated` };
        save(updated);
      }
    }
    return removed;
  }

  // Removes a ticket from the current roadmap and versions the change.
  function removeTicket(projectId, ticketId) {
    const current = getCurrent();
    if (!current || current.project_id !== projectId) return false;
    let removed = false;
    const sprints = current.sprints.map((sprint) => ({ ...sprint, tickets: (sprint.tickets ?? []).filter((ticket) => {
      if (ticket.id !== ticketId) return true;
      removed = true;
      return false;
    }) }));
    if (!removed) return false;
    save({ ...current, version: `${current.version}-ticket-${Date.now()}`, updated_at: new Date().toISOString(), sprints });
    return true;
  }

  // Validates, redacts, and appends a new roadmap version.
  function save(roadmap) {
    validateRoadmap(roadmap);
    if (byVersion.has(roadmap.version)) throw new ConfigurationError(`Roadmap version already exists: ${roadmap.version}.`);
    const stored = Object.freeze(redact(structuredClone(roadmap)));
    if (database) database.run("INSERT INTO governance_roadmaps (version, roadmap_json) VALUES (?, ?)", [stored.version, JSON.stringify(stored)]);
    versions.push(stored);
    byVersion.set(stored.version, stored);
    return structuredClone(stored);
  }

  // Returns the latest roadmap version.
  function getCurrent() {
    return versions.length > 0 ? structuredClone(versions.at(-1)) : undefined;
  }

  // Returns a specific roadmap version by its version string.
  function getVersion(version) {
    if (typeof version !== "string" || version.length === 0) throw new ConfigurationError("A roadmap version is required.");
    const roadmap = byVersion.get(version);
    return roadmap ? structuredClone(roadmap) : undefined;
  }

  // Returns all roadmap versions in insertion order.
  function getAllVersions() {
    return versions.map((roadmap) => structuredClone(roadmap));
  }

  // Reloads all roadmaps from the database.
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

// Creates the roadmaps table if it does not exist.
function ensureTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS governance_roadmaps (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    roadmap_json TEXT NOT NULL
  )`);
}

// Formats AJV validation errors into a readable string.
function ajvErrorsText(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

// Redacts sensitive keys when persisting roadmap content.
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(item)]));
}

// Builds a JSON-schema validator for tickets.
export function createTicketValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema);
  return ajv.getSchema(ticketSchema.$id);
}

// Builds a JSON-schema validator for roadmaps.
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
