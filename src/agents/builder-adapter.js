import { createAgentContract } from "./agent-contract.js";

const BUILDER_TASK_TYPES = new Set(["feature", "bugfix", "refactor", "test", "docs", "maintenance", "custom"]);

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

async function defaultPerform({ task } = {}) {
  return { task_id: task?.id, outcome: "builder_task_completed" };
}
