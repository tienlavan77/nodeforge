import { ConfigurationError } from "../../shared/errors.js";

/**
 * Facade for Agent context. The Agent-facing layer only knows retrieval,
 * summary, and task services; the underlying event/history/memory stores stay
 * behind those services.
 */
export function createAgentContextService({ memoryRetriever, taskSummaries, taskStore } = {}) {
  if (typeof memoryRetriever?.retrieve !== "function") {
    throw new ConfigurationError("Agent Context requires a Memory Retriever.");
  }
  if (typeof taskSummaries?.getByTask !== "function" && typeof taskSummaries?.build !== "function") {
    throw new ConfigurationError("Agent Context requires a Task Summary Store.");
  }
  if (typeof taskStore?.get !== "function") throw new ConfigurationError("Agent Context requires a Task Store.");

  return Object.freeze({ buildContext });

  function buildContext({ projectId, taskId, query = "", domain } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0 || typeof taskId !== "string" || taskId.length === 0) {
      throw new ConfigurationError("Agent Context requires project_id and task_id.");
    }
    if (typeof query !== "string" || (domain !== undefined && typeof domain !== "string")) {
      throw new ConfigurationError("Agent Context query and domain must be strings.");
    }

    const retrieval = memoryRetriever.retrieve({ projectId, taskId, query, domain });
    const summary = taskSummaries.getByTask?.(taskId) ?? taskSummaries.build?.(taskId);
    const currentTask = taskStore.get(taskId) ?? {};

    return {
      projectFacts: [...(retrieval?.relevant_facts ?? [])],
      taskFacts: [...(summary?.facts ?? [])],
      currentTask: { ...currentTask }
    };
  }
}

export const createContextService = createAgentContextService;
