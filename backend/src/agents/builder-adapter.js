// Adapter wrapping builder task handling under the agent contract.
import { createAgentContract } from "./agent-contract.js";

const BUILDER_TASK_TYPES = new Set(["feature", "bugfix", "refactor", "test", "docs", "maintenance", "custom"]);

// Creates a builder agent adapter under the shared contract.
export function createBuilderAdapter({ id = "AGENT-builder", name = "Builder Agent", perform = defaultPerform } = {}) {
  return createAgentContract({
    id,
    name,
    canHandle(task) {
      return Boolean(task && BUILDER_TASK_TYPES.has(task.type));
    },
    async execute(context) {
      const result = await perform(context);
      return { status: "completed", agent_id: id, ...result };
    }
  });
}

// Performs the default task execution for the agent.
async function defaultPerform({ task } = {}) {
  return { task_id: task?.id, outcome: "builder_task_completed" };
}
