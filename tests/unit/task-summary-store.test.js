import assert from "node:assert/strict";
import test from "node:test";

import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";

test("reduces raw task history into concise, useful facts", () => {
  const history = {
    getByTask(taskId) {
      assert.equal(taskId, "TASK-082");
      return [
        record("workflow.started", "started"),
        record("watcher.file_modified", "recorded"),
        record("verification.test_completed", "failed"),
        record("watcher.file_modified", "recorded"),
        record("verification.test_completed", "passed"),
        record("review.completed", "approved"),
        record("workflow.completed", "approved")
      ];
    }
  };
  const summaries = createTaskSummaryStore({ history });
  const summary = summaries.build("TASK-082");

  assert.deepEqual(summary, {
    task_id: "TASK-082",
    facts: ["Builder started work.", "Builder changed project files.", "Tests failed.", "Builder changed project files.", "Tests passed.", "Reviewer approved.", "Task completed."]
  });
  assert.equal(JSON.stringify(summary).includes("event_id"), false);
  assert.equal(JSON.stringify(summary).includes("timestamp"), false);
  assert.deepEqual(summaries.getByTask("TASK-082"), summary);
});

test("does not copy unsupported raw history into a Task Summary", () => {
  const summaries = createTaskSummaryStore({ history: { getByTask: () => [record("agents.message_received", "recorded"), record("agents.message_received", "recorded")] } });

  assert.deepEqual(summaries.build("TASK-082-empty"), { task_id: "TASK-082-empty", facts: [] });
});

function record(action, result) {
  return { event_id: "EVT-082", actor: "builder", action, timestamp: "2026-08-19T17:00:00Z", project_id: "PROJECT-082", task_id: "TASK-082", result };
}
