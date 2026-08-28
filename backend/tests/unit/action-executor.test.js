import assert from "node:assert/strict";
import test from "node:test";

import { createActionExecutor } from "../../src/modules/agent/executor.js";

const plan = {
  taskId: "TASK-090",
  steps: [
    { id: "TASK-090:step-1", type: "analysis", description: "Analyze" },
    { id: "TASK-090:step-2", type: "implementation", description: "Implement" },
    { id: "TASK-090:step-3", type: "verification", description: "Verify" }
  ]
};

test("executes plan steps sequentially and reports completion", async () => {
  const order = [];
  const executor = createActionExecutor({ executeStep: async (step) => {
    order.push(step.id);
  } });

  assert.deepEqual(await executor.execute(plan), { status: "completed", completedSteps: 3, failedStep: null });
  assert.deepEqual(order, plan.steps.map((step) => step.id));
});

test("stops at the first failed step", async () => {
  const order = [];
  const executor = createActionExecutor({ executeStep: async (step) => {
    order.push(step.id);
    if (step.id.endsWith("step-2")) throw new Error("implementation failed");
  } });

  assert.deepEqual(await executor.execute(plan), { status: "failed", completedSteps: 1, failedStep: "TASK-090:step-2" });
  assert.deepEqual(order, ["TASK-090:step-1", "TASK-090:step-2"]);
});

test("rejects an empty execution plan", async () => {
  const executor = createActionExecutor();
  await assert.rejects(() => executor.execute({ taskId: "TASK-090", steps: [] }), /non-empty execution plan/);
});
