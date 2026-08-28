import { ConfigurationError } from "../../shared/errors.js";

export function createProjectMemoryStore({ summaries } = {}) {
  if (typeof summaries?.getByProject !== "function") throw new ConfigurationError("Project Memory requires a Task Summary Store.");
  const memories = new Map();

  return Object.freeze({ build, get });

  function build(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    const sourceSummaries = summaries.getByProject(projectId);
    const sourceFactCount = sourceSummaries.reduce((total, summary) => total + summary.facts.length, 0);
    const facts = [...new Set(sourceSummaries.flatMap(({ facts: summaryFacts }) => summaryFacts.filter(isLongTermFact)))];
    const memory = Object.freeze({ project_id: projectId, facts: Object.freeze(facts), source_fact_count: sourceFactCount });
    memories.set(projectId, memory);
    return cloneMemory(memory);
  }

  function get(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    const memory = memories.get(projectId);
    return memory ? cloneMemory(memory) : undefined;
  }
}

function isLongTermFact(fact) {
  return /\b(decision|architecture|migrat(?:e|ed|ion)?|standard|identity|rule engine|validator|always|must)\b/i.test(fact);
}

function cloneMemory(memory) {
  return { project_id: memory.project_id, facts: [...memory.facts], source_fact_count: memory.source_fact_count };
}
