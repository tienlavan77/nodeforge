import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const decisionSchema = require("../../../schemas/governance/architecture-decision.schema.json");

export function createArchitectureDecisionStore({ validateDecision = createDecisionValidator() } = {}) {
  if (typeof validateDecision !== "function") throw new ConfigurationError("Architecture Decision validation must be a function.");
  const decisions = [];
  const decisionsById = new Map();

  return Object.freeze({ append, getById, getAll, getByType });

  function append(decision) {
    validateDecision(decision);
    if (decisionsById.has(decision.id)) throw new ConfigurationError(`Architecture Decision already exists: ${decision.id}.`);
    const stored = freezeDecision(decision);
    decisions.push(stored);
    decisionsById.set(stored.id, stored);
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
