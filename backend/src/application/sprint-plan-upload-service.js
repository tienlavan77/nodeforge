// Validates and persists sprint plans from uploaded JSON payloads.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");
const sprintPlanSchema = require("../../../schemas/governance/sprint-plan.schema.json");

// Creates a service for uploading and managing sprint plans.
export function createSprintPlanUploadService({ roadmaps, publisher, projectRoot = process.cwd(), isRunning = () => false, logger = console } = {}) {
  if (typeof roadmaps?.save !== "function") throw new ConfigurationError("Sprint Plan Upload requires a Roadmap Store.");
  const validate = createValidator();

  return Object.freeze({ upload, list, get, update, remove, removeTicket });
  function remove({ projectId, sprintId } = {}) {
    get({ projectId, sprintId });
    if (isRunning(sprintId)) { const error = new ConfigurationError(`Sprint is currently running: ${sprintId}.`); error.statusCode = 409; throw error; }
    if (!roadmaps.removeSprint?.(projectId, sprintId)) { const error = new ConfigurationError(`Unknown Sprint Plan: ${sprintId}.`); error.statusCode = 404; throw error; }
    const directory = join(projectRoot, "schemas", "examples");
    for (const file of readdirSync(directory, { withFileTypes: true })) if (file.isFile() && file.name.startsWith("governance-sprint-plan-") && file.name.endsWith(".json")) {
      try { const value = JSON.parse(readFileSync(join(directory, file.name), "utf8")); if (value.id === sprintId) unlinkSync(join(directory, file.name)); } catch { /* unrelated invalid fixture */ }
    }
    publish("sprint.deleted", projectId, { sprint_id: sprintId });
    return { deleted: true, sprint_id: sprintId };
  }
  function list({ projectId } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project id is required.");
    const current = roadmaps.getCurrent?.();
    if (!current || current.project_id !== projectId) return [];
    return structuredClone(current.sprints ?? []);
  }
  function get({ projectId, sprintId } = {}) {
    const sprint = roadmaps.getAllVersions?.().flatMap((roadmap) => roadmap.project_id === projectId ? (roadmap.sprints ?? []) : []).find(({ id }) => id === sprintId);
    if (!sprint) {
      const error = new ConfigurationError(`Unknown Sprint Plan: ${sprintId}.`);
      error.statusCode = 404;
      throw error;
    }
    return structuredClone(sprint);
  }
  function update({ projectId, sprintId, sprintPlan } = {}) {
    const current = get({ projectId, sprintId });
    if (isRunning(sprintId)) { const error = new ConfigurationError(`Sprint is currently running: ${sprintId}.`); error.statusCode = 409; throw error; }
    const next = { ...sprintPlan, id: sprintId, project_id: projectId, roadmap_id: sprintPlan?.roadmap_id ?? current.roadmap_id };
    if (!validate(next)) throw new ConfigurationError(`Invalid Sprint Plan: ${validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
    if (!roadmaps.removeSprint?.(projectId, sprintId)) { const error = new ConfigurationError(`Unknown Sprint Plan: ${sprintId}.`); error.statusCode = 404; throw error; }
    return upload({ projectId, sprintPlan: next }, { eventType: "sprint.updated" });
  }
  function removeTicket({ projectId, ticketId } = {}) {
    const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
    if (!ticket) { const error = new ConfigurationError(`Unknown ticket: ${ticketId}.`); error.statusCode = 404; throw error; }
    if (roadmaps.getCurrent()?.sprints?.find((sprint) => sprint.id === ticket.sprint_id)?.tickets?.length === 1) {
      const error = new ConfigurationError("Cannot delete the last ticket in a sprint; delete the sprint instead."); error.statusCode = 409; throw error;
    }
    if (!roadmaps.removeTicket(projectId, ticketId)) { const error = new ConfigurationError(`Unknown ticket: ${ticketId}.`); error.statusCode = 404; throw error; }
    publish("ticket.deleted", projectId, { ticket_id: ticketId, sprint_id: ticket.sprint_id });
    return { deleted: true, ticket_id: ticketId };
  }
  function upload({ projectId, sprintPlan } = {}, { eventType = "sprint.created" } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project id is required.");
    if (!sprintPlan || typeof sprintPlan !== "object" || Array.isArray(sprintPlan)) throw new ConfigurationError("sprint_plan must be an object.");
    if (sprintPlan.project_id !== projectId) throw new ConfigurationError("Sprint plan project_id must match the target project.");
    if (!validate(sprintPlan)) throw new ConfigurationError(`Invalid Sprint Plan: ${validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
    const duplicate = roadmaps.getAllVersions?.().some((roadmap) => roadmap.sprints?.some((sprint) => sprint.id === sprintPlan.id));
    if (duplicate) {
      const error = new ConfigurationError(`Sprint already exists: ${sprintPlan.id}.`);
      error.statusCode = 409;
      throw error;
    }

    const timestamp = new Date().toISOString();
    const roadmap = {
      id: sprintPlan.roadmap_id,
      project_id: projectId,
      version: sprintPlan.id,
      created_at: timestamp,
      updated_at: timestamp,
      sprints: [structuredClone(sprintPlan)]
    };
    const saved = roadmaps.save(roadmap);
    publish(eventType, projectId, { sprint_id: sprintPlan.id, sprint_plan: structuredClone(sprintPlan), ticket_ids: sprintPlan.tickets.map(({ id }) => id) });
    return { sprint_id: sprintPlan.id, ticket_ids: sprintPlan.tickets.map(({ id }) => id), sprint_plan: structuredClone(sprintPlan), roadmap: saved };
  }
  function publish(type, projectId, payload) {
    try { publisher?.publish?.({ event_id: `EVT-${Date.now()}-${type}`, type, project_id: projectId, timestamp: new Date().toISOString(), payload, metadata: { source: "sprint-plan-service" } }); } catch (error) { logger.error?.("Sprint plan event publisher failed after persistence.", { sprint_id: payload?.sprint_id ?? payload?.sprint_plan?.id, upload_id: payload?.upload_id, event_name: type, error: error.message }); /* stream notification must not undo mutation */ }
  }
}

// Creates a JSON schema validator for sprint plans and tickets.
function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema).addSchema(sprintPlanSchema);
  return ajv.getSchema(sprintPlanSchema.$id);
}
