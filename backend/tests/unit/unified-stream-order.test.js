import assert from "node:assert/strict";
import test from "node:test";
import { createUnifiedStreamOrderer, sortUnifiedStreamEvents } from "../../src/modules/events/unified-stream-order.js";

test("assigns per-task sequence and sorts concurrent event types deterministically", () => {
  const orderer = createUnifiedStreamOrderer();
  const taskId = "TASK-ORDER";
  const emitted = [
    orderer.assign({ event_type: "node.command_result", task_id: taskId, timestamp: "2026-08-23T10:00:00Z", payload: {} }),
    orderer.assign({ event_type: "agent.text_stream", task_id: taskId, timestamp: "2026-08-23T10:00:00Z", payload: {} }),
    orderer.assign({ event_type: "node.execution_step", task_id: taskId, timestamp: "2026-08-23T10:00:00Z", payload: {} })
  ];
  assert.deepEqual(emitted.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(sortUnifiedStreamEvents([...emitted].reverse()).map((event) => event.event_type), ["node.command_result", "agent.text_stream", "node.execution_step"]);
  assert.equal(orderer.assign({ event_type: "agent.text_stream", task_id: "OTHER", timestamp: "2026-08-23T10:00:00Z", payload: {} }).sequence, 1);
});
