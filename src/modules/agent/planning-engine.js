import { ConfigurationError } from "../../shared/errors.js";

const PLAN_STEPS = Object.freeze([
  Object.freeze({ type: "analysis", suffix: "Understand the task requirements." }),
  Object.freeze({ type: "implementation", suffix: "Implement the requested task change." }),
  Object.freeze({ type: "verification", suffix: "Verify the task result against its requirements." })
]);

export function createPlanningEngine() {
  return Object.freeze({ createPlan });

  function createPlan(task) {
    assertTask(task);
    const title = task.title.trim();
    const steps = PLAN_STEPS.map(({ type, suffix }, index) => ({
      id: `${task.id}:step-${index + 1}`,
      type,
      description: `${suffix} (${title})`
    }));
    return Object.freeze({
      taskId: task.id,
      steps: Object.freeze(steps.map((step) => Object.freeze(step)))
    });
  }
}

export function createPlan(task) {
  return createPlanningEngine().createPlan(task);
}

function assertTask(task) {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || task.id.length === 0) {
    throw new ConfigurationError("Planning requires a task with an id.");
  }
  if (typeof task.title !== "string" || task.title.trim().length === 0) {
    throw new ConfigurationError("Planning requires a task with a title.");
  }
}
