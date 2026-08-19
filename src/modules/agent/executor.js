import { ConfigurationError } from "../../shared/errors.js";

export function createActionExecutor({ executeStep = async () => {} } = {}) {
  if (typeof executeStep !== "function") throw new ConfigurationError("Action Executor requires an executeStep function.");

  return Object.freeze({ execute });

  async function execute(plan) {
    assertPlan(plan);
    let completedSteps = 0;
    for (const step of plan.steps) {
      try {
        const result = await executeStep(step, plan);
        if (result === false) throw new Error("Step returned false.");
        completedSteps += 1;
      } catch {
        return Object.freeze({
          status: "failed",
          completedSteps,
          failedStep: step.id
        });
      }
    }
    return Object.freeze({ status: "completed", completedSteps, failedStep: null });
  }
}

export async function execute(plan, options) {
  return createActionExecutor(options).execute(plan);
}

function assertPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new ConfigurationError("Action Executor requires a non-empty execution plan.");
  }
  if (typeof plan.taskId !== "string" || plan.taskId.length === 0) throw new ConfigurationError("Execution plan requires taskId.");
  if (plan.steps.some((step) => !step || typeof step.id !== "string" || step.id.length === 0)) {
    throw new ConfigurationError("Execution plan steps require ids.");
  }
}
