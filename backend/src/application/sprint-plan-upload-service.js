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

export function createSprintPlanUploadService({ roadmaps, projectRoot = process.cwd(), isRunning = () => false } = {}) {
  if (typeof roadmaps?.save !== "function") throw new ConfigurationError("Sprint Plan Upload requires a Roadmap Store.");
  const validate = createValidator();

  return Object.freeze({ upload, get, remove, removeTicket });

  function remove({ projectId, sprintId } = {}) {
    get({ projectId, sprintId });
    if (isRunning(sprintId)) { const error = new ConfigurationError(`Sprint is currently running: ${sprintId}.`); error.statusCode = 409; throw error; }
    if (!roadmaps.removeSprint?.(projectId, sprintId)) { const error = new ConfigurationError(`Unknown Sprint Plan: ${sprintId}.`); error.statusCode = 404; throw error; }
    const directory = join(projectRoot, "schemas", "examples");
    for (const file of readdirSync(directory, { withFileTypes: true })) if (file.isFile() && file.name.startsWith("governance-sprint-plan-") && file.name.endsWith(".json")) {
      try { const value = JSON.parse(readFileSync(join(directory, file.name), "utf8")); if (value.id === sprintId) unlinkSync(join(directory, file.name)); } catch { /* unrelated invalid fixture */ }
    }
    return { deleted: true, sprint_id: sprintId };
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

  function removeTicket({ projectId, ticketId } = {}) {
    const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
    if (!ticket) { const error = new ConfigurationError(`Unknown ticket: ${ticketId}.`); error.statusCode = 404; throw error; }
    if (roadmaps.getCurrent()?.sprints?.find((sprint) => sprint.id === ticket.sprint_id)?.tickets?.length === 1) {
      const error = new ConfigurationError("Cannot delete the last ticket in a sprint; delete the sprint instead."); error.statusCode = 409; throw error;
    }
    if (!roadmaps.removeTicket(projectId, ticketId)) { const error = new ConfigurationError(`Unknown ticket: ${ticketId}.`); error.statusCode = 404; throw error; }
    return { deleted: true, ticket_id: ticketId };
  }

  function upload({ projectId, sprintPlan } = {}) {
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
    return { sprint_id: sprintPlan.id, ticket_ids: sprintPlan.tickets.map(({ id }) => id), sprint_plan: structuredClone(sprintPlan), roadmap: saved };
  }
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema).addSchema(sprintPlanSchema);
  return ajv.getSchema(sprintPlanSchema.$id);
}
