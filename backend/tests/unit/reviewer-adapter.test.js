import assert from "node:assert/strict";
import test from "node:test";

import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";

test("Reviewer Adapter conforms to the Agent Contract and handles review tasks", async () => {
  const adapter = createReviewerAdapter({
    id: "AGENT-reviewer-110",
    perform: async ({ task, context }) => ({ task_id: task.id, outcome: "changes_requested", reviewed_facts: context.projectFacts.length, status: "changes_requested" })
  });

  assert.equal(adapter.id, "AGENT-reviewer-110");
  assert.equal(adapter.canHandle({ type: "review" }), true);
  assert.equal(adapter.canHandle({ type: "feature" }), false);
  assert.deepEqual(await adapter.execute({
    task: { id: "TASK-110", type: "review" },
    context: { projectFacts: ["Auth migrated to v2."] }
  }), { status: "changes_requested", agent_id: "AGENT-reviewer-110", task_id: "TASK-110", outcome: "changes_requested", reviewed_facts: 1 });
});

test("Reviewer Adapter supplies a normalized default review result", async () => {
  const adapter = createReviewerAdapter();
  assert.deepEqual(await adapter.execute({ task: { id: "TASK-110" } }), {
    status: "approved", agent_id: "AGENT-reviewer", task_id: "TASK-110", outcome: "review_completed"
  });
});
