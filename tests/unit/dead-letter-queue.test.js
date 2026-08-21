import assert from "node:assert/strict";
import test from "node:test";

import { createDeadLetterQueue } from "../../src/modules/recovery/dead-letter-queue.js";

test("enqueues failures with payload and reason in insertion order", () => {
  let id = 0;
  const queue = createDeadLetterQueue({ createId: () => `DLQ-${++id}`, clock: () => new Date("2026-08-20T00:00:00Z") });
  const firstPayload = { taskId: "TASK-097-A", attempt: 3, details: { code: "TIMEOUT" } };
  queue.enqueue({ type: "agent.operation", payload: firstPayload }, "max_attempts_exceeded");
  queue.enqueue({ type: "event.publish", payload: { eventId: "EVT-097" } }, "transport_unavailable");
  firstPayload.details.code = "mutated-after-enqueue";

  assert.equal(queue.size(), 2);
  assert.deepEqual(queue.getAll(), [
    { id: "DLQ-1", type: "agent.operation", payload: { taskId: "TASK-097-A", attempt: 3, details: { code: "TIMEOUT" } }, reason: "max_attempts_exceeded", timestamp: "2026-08-20T00:00:00.000Z" },
    { id: "DLQ-2", type: "event.publish", payload: { eventId: "EVT-097" }, reason: "transport_unavailable", timestamp: "2026-08-20T00:00:00.000Z" }
  ]);
});

test("queries failures by type without retrying or removing them", () => {
  const queue = createDeadLetterQueue({ createId: () => "DLQ-097" });
  queue.enqueue({ type: "agent.operation", payload: { taskId: "TASK-097" } }, "failed");
  queue.enqueue({ type: "agent.operation", payload: { taskId: "TASK-098" } }, "failed");
  assert.equal(queue.getByType("agent.operation").length, 2);
  assert.equal(queue.getByType("other").length, 0);
  assert.equal(queue.size(), 2);
});

test("rejects records without type or reason", () => {
  const queue = createDeadLetterQueue();
  assert.throws(() => queue.enqueue({ payload: {} }, "failed"), /require a type/);
  assert.throws(() => queue.enqueue({ type: "agent.operation", payload: {} }, ""), /require a reason/);
});

test("dequeues, drains, and purges records", () => {
  const queue = createDeadLetterQueue({ createId: (() => { let i = 0; return () => `DLQ-${++i}`; })(), clock: (() => { let i = 0; return () => new Date(`2026-08-20T0${i++}:00:00Z`); })() });
  queue.enqueue({ type: "a", payload: {} }, "failed");
  queue.enqueue({ type: "b", payload: {} }, "failed");
  assert.equal(queue.dequeue("DLQ-1").id, "DLQ-1");
  assert.equal(queue.size(), 1);
  assert.equal(queue.drain().length, 1);
  assert.equal(queue.size(), 0);
  queue.enqueue({ type: "c", payload: {} }, "failed");
  assert.equal(queue.purge("2026-08-21T00:00:00Z").length, 1);
});
