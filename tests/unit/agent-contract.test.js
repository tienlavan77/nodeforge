import assert from "node:assert/strict";
import test from "node:test";

import { createAgentContract, validateAgentContract } from "../../src/agents/agent-contract.js";

test("accepts Builder and Reviewer implementations through one contract", async () => {
  const builder = createAgentContract({
    id: "AGENT-builder",
    name: "Builder Agent",
    canHandle: (task) => task.type === "feature",
    execute: async (context) => ({ status: "completed", role: "builder", task_id: context.taskId })
  });
  const reviewer = createAgentContract({
    id: "AGENT-reviewer",
    name: "Reviewer Agent",
    canHandle: (task) => task.type === "review",
    execute: async () => ({ status: "approved", role: "reviewer" })
  });

  assert.equal(builder.canHandle({ type: "feature" }), true);
  assert.equal(reviewer.canHandle({ type: "review" }), true);
  assert.deepEqual(await builder.execute({ taskId: "TASK-108" }), { status: "completed", role: "builder", task_id: "TASK-108" });
  assert.deepEqual(await reviewer.execute({ taskId: "TASK-108" }), { status: "approved", role: "reviewer" });
});

test("validates contract shape and normalized execute results", async () => {
  assert.equal(validateAgentContract({ id: "A", name: "Agent", canHandle: () => true, execute: () => ({ status: "ok" }) }), true);
  assert.throws(() => createAgentContract({ id: "A", name: "Agent", execute: () => ({ status: "ok" }) }), /canHandle/);
  const invalid = createAgentContract({ id: "A", name: "Agent", canHandle: () => true, execute: () => ({}) });
  await assert.rejects(() => invalid.execute({}), /result object with status/);
});
