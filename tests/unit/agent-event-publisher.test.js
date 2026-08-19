import assert from "node:assert/strict";
import test from "node:test";

import { createAgentEventPublisher } from "../../src/modules/agent/agent-event-publisher.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";

test("publishes the Agent Runtime lifecycle to the Event Store", () => {
  const store = createEventStore();
  const events = createAgentEventPublisher({
    publisher: createEventPublisher({ store }),
    projectId: "PROJECT-091",
    taskId: "TASK-091",
    sessionId: "SESSION-091",
    agentId: "AGENT-091",
    createEventId: sequence("EVT-091"),
    clock: () => new Date("2026-08-19T20:00:00Z")
  });

  assert.equal(events.started({ state: "RUNNING" }).accepted, true);
  assert.equal(events.planCreated({ step_count: 3 }).accepted, true);
  assert.equal(events.stepStarted({ step_id: "STEP-1" }).accepted, true);
  assert.equal(events.stepCompleted({ step_id: "STEP-1" }).accepted, true);
  assert.equal(events.failed({ reason: "verification failed" }).accepted, true);
  assert.equal(events.completed({ state: "COMPLETED" }).accepted, true);

  assert.deepEqual(store.getAll().map(({ event_type }) => event_type), [
    "agent.started", "agent.plan.created", "agent.step.started", "agent.step.completed", "agent.failed", "agent.completed"
  ]);
  assert.deepEqual(store.getById("EVT-091-1").metadata, {
    source: "agent-runtime",
    session_id: "SESSION-091",
    agent_id: "AGENT-091",
    project_id: "PROJECT-091",
    task_id: "TASK-091"
  });
});

test("delegates duplicate event identities to the Event Publisher idempotency policy", () => {
  const store = createEventStore();
  const events = createAgentEventPublisher({
    publisher: createEventPublisher({ store }), projectId: "PROJECT-091", taskId: "TASK-091", sessionId: "SESSION-091", agentId: "AGENT-091",
    clock: () => new Date("2026-08-19T20:00:00Z")
  });
  const options = { eventId: "EVT-091-duplicate" };

  assert.equal(events.completed({ state: "COMPLETED" }, options).accepted, true);
  assert.deepEqual(events.completed({ state: "COMPLETED" }, options), {
    accepted: false,
    reason: "duplicate_event_id",
    delivered: 0,
    event: store.getById("EVT-091-duplicate")
  });
  assert.equal(store.getAll().length, 1);
});

function sequence(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
