// Read model that projects stored decisions into architecture, standards, and constraint views.
import { ConfigurationError } from "../../shared/errors.js";

// Creates a read model that classifies stored decisions by type.
export function createArchitectureKnowledgeModel({ decisions } = {}) {
  if (typeof decisions?.getAll !== "function") throw new ConfigurationError("Architecture Knowledge Model requires an Architecture Decision Store.");

  return Object.freeze({ getArchitecture, getStandards, getConstraints, getDecisions });

  // Returns decisions typed as architecture.
  function getArchitecture() {
    return select("architecture");
  }

  // Returns decisions typed as standards.
  function getStandards() {
    return select("standard");
  }

  // Returns decisions typed as constraints.
  function getConstraints() {
    return select("constraint");
  }

  // Returns all decisions as cloned records.
  function getDecisions() {
    return decisions.getAll().map(cloneDecision);
  }

  // Filters decisions by the given type string.
  function select(type) {
    return decisions.getAll().filter((decision) => decision.type === type).map(cloneDecision);
  }
}

// Deep-clones a decision record.
function cloneDecision(decision) {
  return structuredClone(decision);
}
