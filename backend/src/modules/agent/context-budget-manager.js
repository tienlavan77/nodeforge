import { ConfigurationError } from "../../shared/errors.js";

export function createContextBudgetManager() {
  return Object.freeze({ selectFacts });

  function selectFacts({ facts, maxFacts } = {}) {
    if (!Array.isArray(facts) || facts.some((fact) => typeof fact !== "string")) {
      throw new ConfigurationError("Context facts must be an array of strings.");
    }
    if (!Number.isInteger(maxFacts) || maxFacts < 0) {
      throw new ConfigurationError("Context maxFacts must be a non-negative integer.");
    }
    return Object.freeze(facts.slice(0, maxFacts));
  }
}

export function selectFacts(input) {
  return createContextBudgetManager().selectFacts(input);
}
