import { createAgentContract } from "./agent-contract.js";

export function createReviewerAdapter({ id = "AGENT-reviewer", name = "Reviewer Agent", perform = defaultPerform } = {}) {
  return createAgentContract({
    id,
    name,
    canHandle(task) {
      return task?.type === "review";
    },
    async execute(context) {
      const result = await perform(context);
      return { status: "approved", agent_id: id, ...result };
    }
  });
}

async function defaultPerform({ task } = {}) {
  return { task_id: task?.id, outcome: "review_completed" };
}
