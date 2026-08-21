import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const commandSchema = require("../../../schemas/core/command.schema.json");
const eventSchema = require("../../../schemas/core/event.schema.json");
const sprintSchema = require("../../../schemas/roadmap/sprint.schema.json");
const commitSchema = require("../../../schemas/roadmap/commit.schema.json");
const verificationPlanSchema = require("../../../schemas/verification/verification-plan.schema.json");

const REQUEST_TYPE = "sprints.request_plan";
const PROPOSAL_TYPE = "sprints.plan_proposed";

export function createSprintLeaderLoop({ projectId, createRequestId = () => `REQ-${randomUUID()}`, createEventId = () => `EVT-${randomUUID()}`, clock = () => new Date() } = {}) {
  if (typeof projectId !== "string" || projectId.length === 0 || typeof createRequestId !== "function" || typeof createEventId !== "function" || typeof clock !== "function") {
    throw new ConfigurationError("Sprint Leader loop requires project_id and ID/time factories.");
  }
  const validateCommand = createValidator(commandSchema, "command");
  const validateEvent = createValidator(eventSchema, "event");
  const validateSprint = createValidator(sprintSchema, "sprint");

  return Object.freeze({ requestPlan, acceptPlan });

  function requestPlan({ completedSprintId, objective = "Plan the next sprint." } = {}) {
    if (typeof completedSprintId !== "string" || completedSprintId.length === 0) throw new ConfigurationError("completed_sprint_id is required.");
    const command = {
      type: REQUEST_TYPE,
      request_id: createRequestId(),
      project_id: projectId,
      timestamp: clock().toISOString(),
      payload: { completed_sprint_id: completedSprintId, objective }
    };
    validateCommand(command);
    return Object.freeze(command);
  }

  function acceptPlan(event) {
    validateEvent(event);
    if (event.type !== PROPOSAL_TYPE) throw new ConfigurationError(`Expected ${PROPOSAL_TYPE}, received ${event.type}.`);
    if (event.project_id !== projectId) throw new ConfigurationError("Sprint plan event belongs to a different project.");
    if (!event.payload?.sprint) throw new ConfigurationError("Sprint plan event requires payload.sprint.");
    validateSprint(event.payload.sprint);
    return Object.freeze({ request_id: event.request_id, sprint: Object.freeze({ ...event.payload.sprint }) });
  }
}

function createValidator(schema, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(commitSchema).addSchema(verificationPlanSchema).addSchema(schema);
  const validate = ajv.getSchema(schema.$id);
  return (value) => {
    if (!validate(value)) throw new ConfigurationError(`Invalid ${label}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}
