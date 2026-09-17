// Project-level memory that aggregates long-term facts from task summaries.
import { ConfigurationError } from "../../shared/errors.js";

// Creates a per-project memory that derives durable facts from task summaries.
export function createProjectMemoryStore({ summaries } = {}) {
  if (typeof summaries?.getByProject !== "function") throw new ConfigurationError("Project Memory requires a Task Summary Store.");
  const memories = new Map();

  return Object.freeze({ build, get });

  // Aggregates filtered facts for a project from its task summaries.
  function build(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    const sourceSummaries = summaries.getByProject(projectId);
    const sourceFactCount = sourceSummaries.reduce((total, summary) => total + summary.facts.length, 0);
    const facts = [...new Set(sourceSummaries.flatMap(({ facts: summaryFacts }) => summaryFacts.filter(isLongTermFact)))];
    const memory = Object.freeze({ project_id: projectId, facts: Object.freeze(facts), source_fact_count: sourceFactCount });
    memories.set(projectId, memory);
    return cloneMemory(memory);
  }

  // Returns the cached memory for a project.
  function get(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    const memory = memories.get(projectId);
    return memory ? cloneMemory(memory) : undefined;
  }
}

// Tests whether a fact is durable enough for project memory.
function isLongTermFact(fact) {
  return /\b(decision|architecture|migrat(?:e|ed|ion)?|standard|identity|rule engine|validator|always|must)\b/i.test(fact);
}

// Clones a project memory record for return.
function cloneMemory(memory) {
  return { project_id: memory.project_id, facts: [...memory.facts], source_fact_count: memory.source_fact_count };
}
