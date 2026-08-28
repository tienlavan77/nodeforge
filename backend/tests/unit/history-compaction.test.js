import assert from "node:assert/strict";
import test from "node:test";

import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";

test("archives one hundred active history records while preserving audit and Project Memory", () => {
  const subscriptions = createSubscriptionRegistry();
  const history = createHistoryStore({ subscriptions });
  const publisher = createEventPublisher({ store: createEventStore(), subscriptions, source: "workflow-engine" });
  for (let index = 0; index < 100; index += 1) {
    publisher.publish({ event_id: `EVT-084-${index}`, type: index === 0 ? "workflow.started" : "verification.test_completed", project_id: "PROJECT-084", task_id: "TASK-084", timestamp: "2026-08-19T18:00:00Z", payload: { result: index % 2 === 0 ? "passed" : "failed" } });
  }
  const summaries = createTaskSummaryStore({ history });
  summaries.build("TASK-084");
  const memories = createProjectMemoryStore({ summaries });
  const memoryBefore = memories.build("PROJECT-084");

  assert.deepEqual(history.getStats(), { active_records: 100, archived_records: 0, total_records: 100 });
  assert.deepEqual(history.compact({ projectId: "PROJECT-084", taskIds: ["TASK-084"] }), { project_id: "PROJECT-084", archived: 100, active_records: 0, archived_records: 100 });
  assert.deepEqual(history.getStats(), { active_records: 0, archived_records: 100, total_records: 100 });
  assert.equal(history.getByProject("PROJECT-084").length, 100);
  assert.equal(history.getByTask("TASK-084").length, 100);
  assert.deepEqual(memories.get("PROJECT-084"), memoryBefore);
});
