import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const roadmapSchema = require("../../../schemas/governance/roadmap.schema.json");
const sprintPlanSchema = require("../../../schemas/governance/sprint-plan.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");

export function createRoadmapStore({ validateRoadmap = createRoadmapValidator() } = {}) {
  if (typeof validateRoadmap !== "function") throw new ConfigurationError("Roadmap validation must be a function.");
  const versions = [];
  const byVersion = new Map();

  return Object.freeze({ save, getCurrent, getVersion, getAllVersions });

  function save(roadmap) {
    validateRoadmap(roadmap);
    if (byVersion.has(roadmap.version)) throw new ConfigurationError(`Roadmap version already exists: ${roadmap.version}.`);
    const stored = Object.freeze(structuredClone(roadmap));
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
