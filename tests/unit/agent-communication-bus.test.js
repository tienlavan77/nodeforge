import assert from "node:assert/strict";
import test from "node:test";

import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

test("persists before deterministic dispatch and supports multiple subscribers", () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const received = [];
  const first = (message) => {
    received.push(`first:${message.id}`);
    message.payload.changed = true;
  };
  const second = (message) => received.push(`second:${message.id}`);
  bus.subscribe("NODE-123", first);
  bus.subscribe("NODE-123", second);
  const sent = message("MSG-123-1", "BUILDER-123", "NODE-123");

  const persisted = bus.send(sent);

  assert.deepEqual(received, ["first:MSG-123-1", "second:MSG-123-1"]);
  assert.deepEqual(store.getAll().map(({ id }) => id), ["MSG-123-1"]);
  assert.equal(store.getById("MSG-123-1").payload.changed, undefined);
  assert.equal(persisted.payload.changed, undefined);
  sent.payload.changed = "caller mutation";
  assert.equal(store.getById("MSG-123-1").payload.changed, undefined);
});

test("does not deliver duplicate registrations and unsubscribe stops delivery", () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  const received = [];
  const handler = (message) => received.push(message.id);
  bus.subscribe("NODE-123", handler);
  bus.subscribe("NODE-123", handler);
  bus.send(message("MSG-123-2", "RUNTIME-123", "NODE-123"));
  assert.deepEqual(received, ["MSG-123-2"]);
  assert.equal(bus.unsubscribe("NODE-123", handler), true);
  assert.equal(bus.unsubscribe("NODE-123", handler), false);
  bus.send(message("MSG-123-3", "RUNTIME-123", "NODE-123"));
  assert.deepEqual(received, ["MSG-123-2"]);
});

test("rejects invalid messages before persistence or dispatch", () => {
  const store = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store });
  let deliveries = 0;
  bus.subscribe("NODE-123", () => { deliveries += 1; });
  const invalid = message("MSG-123-invalid", "RUNTIME-123", "NODE-123");
  delete invalid.timestamp;

  assert.throws(() => bus.send(invalid), /Invalid Agent Message/);
  assert.equal(store.getAll().length, 0);
  assert.equal(deliveries, 0);
});

function message(id, senderId, recipientId) {
  return {
    id,
    project_id: "PROJECT-123",
    sender: { id: senderId, role: senderId.startsWith("BUILDER") ? "builder" : "runtime" },
    recipient: { id: recipientId, role: "node" },
    message_type: "runtime.request",
    payload: { task_id: "TASK-123" },
    timestamp: "2026-08-20T08:30:00Z"
  };
}
