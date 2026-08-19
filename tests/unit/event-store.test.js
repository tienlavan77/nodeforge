import assert from "node:assert/strict";
import test from "node:test";

import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { ConfigurationError } from "../../src/shared/errors.js";

test("publishes validated events into an ordered, readable audit store", () => {
  const store = createEventStore();
  const publisher = createEventPublisher({ store, source: "workflow-engine" });
  const first = publisher.publish(event("EVT-078-001", "workflow.started", { workflow_id: "WF-078" }));
  const second = publisher.publish(event("EVT-078-002", "workflow.completed", { workflow_id: "WF-078" }));

  assert.deepEqual(first, { accepted: true, delivered: 0, event: { event_id: "EVT-078-001", event_type: "workflow.started", timestamp: "2026-08-19T14:00:00Z", source: "workflow-engine", payload: { workflow_id: "WF-078" }, metadata: {} } });
  assert.deepEqual(store.getById("EVT-078-002"), second.event);
  assert.deepEqual(store.getAll().map(({ event_id }) => event_id), ["EVT-078-001", "EVT-078-002"]);
  assert.deepEqual(store.getByType("workflow.started"), [first.event]);
});

test("preserves event source metadata and rejects invalid publication", () => {
  const store = createEventStore();
  const publisher = createEventPublisher({ store, source: "node" });
  const published = publisher.publish({ ...event("EVT-078-003", "agents.error", { reason: "timeout" }), metadata: { source: "agent-supervisor", trace: "TRACE-078" } });

  assert.equal(published.event.source, "agent-supervisor");
  published.event.payload.reason = "changed-by-caller";
  assert.equal(store.getById("EVT-078-003").payload.reason, "timeout");
  assert.throws(() => publisher.publish({ event_id: "EVT-invalid" }), ConfigurationError);
  assert.equal(store.getAll().length, 1);
});

test("accepts one Event identity and ignores exact duplicate publication", () => {
  const store = createEventStore();
  const publisher = createEventPublisher({ store });
  const duplicate = event("EVT-079-001", "workflow.completed", { workflow_id: "WF-079" });

  assert.equal(publisher.publish(duplicate).accepted, true);
  assert.deepEqual(publisher.publish(duplicate), { accepted: false, delivered: 0, reason: "duplicate_event_id", event: store.getById("EVT-079-001") });
  assert.equal(publisher.publish(duplicate).accepted, false);
  assert.equal(store.getAll().length, 1);
});

test("rejects a reused Event identity with different content", () => {
  const store = createEventStore();
  const publisher = createEventPublisher({ store });
  publisher.publish(event("EVT-079-conflict", "workflow.started", { workflow_id: "WF-079" }));

  assert.throws(() => publisher.publish(event("EVT-079-conflict", "workflow.completed", { workflow_id: "WF-079" })), { code: "EVENT_ID_CONFLICT" });
  assert.equal(store.getAll().length, 1);
});

test("delivers published events only to matching subscriptions and stops after unsubscribe", () => {
  const store = createEventStore();
  const subscriptions = createSubscriptionRegistry();
  const publisher = createEventPublisher({ store, subscriptions, validateEvent: () => true });
  const authEvents = [];
  const workflowEvents = [];
  const authSubscription = subscriptions.subscribe("auth.*", (event) => authEvents.push(event));
  subscriptions.subscribe("workflow.*", (event) => workflowEvents.push(event));

  assert.equal(publisher.publish({ event_id: "EVT-080-001", type: "auth.login", timestamp: "2026-08-19T15:00:00Z", payload: { user: "builder" } }).delivered, 1);
  assert.equal(authEvents.length, 1);
  assert.equal(workflowEvents.length, 0);
  assert.equal(subscriptions.unsubscribe(authSubscription), true);
  assert.equal(publisher.publish({ event_id: "EVT-080-002", type: "auth.login", timestamp: "2026-08-19T15:00:01Z", payload: { user: "builder" } }).delivered, 0);
  assert.equal(authEvents.length, 1);
});

function event(eventId, type, payload) {
  return { event_id: eventId, type, project_id: "PROJECT-078", timestamp: "2026-08-19T14:00:00Z", payload };
}
