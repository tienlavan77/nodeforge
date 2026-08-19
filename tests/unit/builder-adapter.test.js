import assert from "node:assert/strict";
import test from "node:test";

import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";

test("Builder Adapter conforms to the Agent Contract and handles Builder tasks", async () => {
  const adapter = createBuilderAdapter({
    id: "AGENT-builder-109",
    perform: async ({ task, context }) => ({ task_id: task.id, outcome: "implemented", used_facts: context.projectFacts.length })
  });

  assert.equal(adapter.id, "AGENT-builder-109");
  assert.equal(adapter.canHandle({ type: "feature" }), true);
  assert.equal(adapter.canHandle({ type: "bugfix" }), true);
  assert.equal(adapter.canHandle({ type: "review" }), false);
  assert.deepEqual(await adapter.execute({
    task: { id: "TASK-109", type: "feature" },
    context: { projectFacts: ["Auth migrated to v2."] }
  }), { status: "completed", agent_id: "AGENT-builder-109", task_id: "TASK-109", outcome: "implemented", used_facts: 1 });
});

test("Builder Adapter supplies a normalized default result", async () => {
  const adapter = createBuilderAdapter();
  assert.deepEqual(await adapter.execute({ task: { id: "TASK-109" } }), {
    status: "completed", agent_id: "AGENT-builder", task_id: "TASK-109", outcome: "builder_task_completed"
  });
});
