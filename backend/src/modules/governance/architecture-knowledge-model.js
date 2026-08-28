import { ConfigurationError } from "../../shared/errors.js";

export function createArchitectureKnowledgeModel({ decisions } = {}) {
  if (typeof decisions?.getAll !== "function") throw new ConfigurationError("Architecture Knowledge Model requires an Architecture Decision Store.");

  return Object.freeze({ getArchitecture, getStandards, getConstraints, getDecisions });

  function getArchitecture() {
    return select("architecture");
  }

  function getStandards() {
    return select("standard");
  }

  function getConstraints() {
    return select("constraint");
  }

  function getDecisions() {
    return decisions.getAll().map(cloneDecision);
  }

  function select(type) {
    return decisions.getAll().filter((decision) => decision.type === type).map(cloneDecision);
  }
}

function cloneDecision(decision) {
  return structuredClone(decision);
}
