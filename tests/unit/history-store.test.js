import assert from "node:assert/strict";
import test from "node:test";

import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";

test("projects accepted events into an audit trail queryable by project and task", () => {
  const subscriptions = createSubscriptionRegistry();
  const history = createHistoryStore({ subscriptions });
  const publisher = createEventPublisher({ store: createEventStore(), subscriptions, source: "workflow-engine" });
  publisher.publish(event("EVT-081-001", "workflow.started", "PROJECT-081", "TASK-081", { status: "started" }));
  publisher.publish(event("EVT-081-002", "verification.test_completed", "PROJECT-081", "TASK-081", { result: "passed" }));
  publisher.publish(event("EVT-081-003", "workflow.completed", "PROJECT-other", "TASK-other", { outcome: "approved" }));

  assert.deepEqual(history.getByProject("PROJECT-081"), [
    { event_id: "EVT-081-001", actor: "workflow-engine", action: "workflow.started", timestamp: "2026-08-19T16:00:00Z", project_id: "PROJECT-081", task_id: "TASK-081", result: "started", tier: "hot" },
    { event_id: "EVT-081-002", actor: "workflow-engine", action: "verification.test_completed", timestamp: "2026-08-19T16:00:00Z", project_id: "PROJECT-081", task_id: "TASK-081", result: "passed", tier: "hot" }
  ]);
  assert.equal(history.getByTask("TASK-081").length, 2);
});

test("stops projecting events after the History Store closes", () => {
  const subscriptions = createSubscriptionRegistry();
  const history = createHistoryStore({ subscriptions });
  const publisher = createEventPublisher({ store: createEventStore(), subscriptions, source: "node" });
  assert.equal(history.close(), true);
  publisher.publish(event("EVT-081-004", "workflow.completed", "PROJECT-081", "TASK-081", { status: "completed" }));
  assert.deepEqual(history.getByProject("PROJECT-081"), []);
});

function event(eventId, type, projectId, taskId, payload) {
  return { event_id: eventId, type, project_id: projectId, task_id: taskId, timestamp: "2026-08-19T16:00:00Z", payload };
}
