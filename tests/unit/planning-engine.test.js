import assert from "node:assert/strict";
import test from "node:test";

import { createPlanningEngine } from "../../src/modules/agent/planning-engine.js";

const task = { id: "TASK-089", title: "Add context budget support", type: "feature" };

test("creates an ordered execution plan for a task", () => {
  const plan = createPlanningEngine().createPlan(task);

  assert.equal(plan.taskId, task.id);
  assert.ok(plan.steps.length >= 1);
  assert.deepEqual(plan.steps.map(({ id, type }) => ({ id, type })), [
    { id: "TASK-089:step-1", type: "analysis" },
    { id: "TASK-089:step-2", type: "implementation" },
    { id: "TASK-089:step-3", type: "verification" }
  ]);
});

test("produces the same plan for the same task input", () => {
  const engine = createPlanningEngine();
  assert.deepEqual(engine.createPlan(task), engine.createPlan({ ...task }));
});

test("rejects a task without an id or title", () => {
  const engine = createPlanningEngine();
  assert.throws(() => engine.createPlan({ title: task.title }), /task with an id/);
  assert.throws(() => engine.createPlan({ id: task.id }), /task with a title/);
});
