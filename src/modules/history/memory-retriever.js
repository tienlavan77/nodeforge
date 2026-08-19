import { ConfigurationError } from "../../shared/errors.js";

export function createMemoryRetriever({ memory } = {}) {
  if (typeof memory?.get !== "function") throw new ConfigurationError("Memory Retrieval requires a Project Memory Store.");

  return Object.freeze({ retrieve });

  function retrieve({ projectId, taskId, query = "", domain } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0 || typeof taskId !== "string" || taskId.length === 0) {
      throw new ConfigurationError("Memory Retrieval requires project_id and task_id.");
    }
    if (typeof query !== "string" || (domain !== undefined && typeof domain !== "string")) {
      throw new ConfigurationError("Memory Retrieval query and domain must be strings.");
    }
    const projectMemory = memory.get(projectId);
    const terms = tokenize(`${query} ${domain ?? ""}`);
    const relevantFacts = projectMemory?.facts.filter((fact) => terms.length > 0 && terms.every((term) => fact.toLowerCase().includes(term))) ?? [];
    return Object.freeze({
      project_id: projectId,
      task_id: taskId,
      source: "project_memory",
      relevant_facts: Object.freeze([...relevantFacts])
    });
  }
}

function tokenize(value) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? [])];
}
