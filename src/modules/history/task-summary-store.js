import { ConfigurationError } from "../../shared/errors.js";

export function createTaskSummaryStore({ history } = {}) {
  if (typeof history?.getByTask !== "function") throw new ConfigurationError("Task Summary requires a History Store.");
  const summaries = new Map();

  return Object.freeze({ build, getByTask, getByProject });

  function build(taskId) {
    if (typeof taskId !== "string" || taskId.length === 0) throw new ConfigurationError("A task_id is required.");
    const records = history.getByTask(taskId);
    const projectId = records[0]?.project_id;
    const facts = [];
    for (const record of records) {
      const fact = factFromRecord(record);
      if (fact && facts.at(-1) !== fact) facts.push(fact);
    }
    const summary = Object.freeze({ task_id: taskId, ...(projectId ? { project_id: projectId } : {}), facts: Object.freeze(facts) });
    summaries.set(taskId, summary);
    return cloneSummary(summary);
  }

  function getByTask(taskId) {
    if (typeof taskId !== "string" || taskId.length === 0) throw new ConfigurationError("A task_id is required.");
    const summary = summaries.get(taskId);
    return summary ? cloneSummary(summary) : undefined;
  }

  function getByProject(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    const taskIds = [...new Set(history.getByProject(projectId).map(({ task_id: taskId }) => taskId).filter(Boolean))];
    return taskIds.map((taskId) => summaries.get(taskId) ?? build(taskId)).map(cloneSummary);
  }
}

function factFromRecord({ action, result, long_term_fact: longTermFact }) {
  if (longTermFact) return longTermFact;
  const known = {
    "workflow.started": "Builder started work.",
    "verification.test_completed": result === "passed" ? "Tests passed." : result === "failed" ? "Tests failed." : undefined,
    "review.requested": "Reviewer received the task.",
    "review.completed": result === "approved" ? "Reviewer approved." : result === "changes_requested" ? "Reviewer requested changes." : undefined,
    "agent.completed": result === "completed" ? "Agent completed the task." : undefined,
    "workflow.completed": "Task completed."
  };
  return known[action] ?? (action === "watcher.file_modified" ? "Builder changed project files." : undefined);
}

function cloneSummary(summary) {
  return { task_id: summary.task_id, ...(summary.project_id ? { project_id: summary.project_id } : {}), facts: [...summary.facts] };
}
