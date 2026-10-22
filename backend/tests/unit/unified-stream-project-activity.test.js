// Verify live SDK tool activity reaches its project's UI monitor without crossing project boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createUnifiedStreamPublisher } from "../../scripts/control-api-unified-stream.mjs";
import { createUnifiedStreamOrderer } from "../../src/modules/events/unified-stream-order.js";
import { createProjectStream } from "../../src/transport/sse/project-stream.js";
import { isProjectStreamEvent } from "../../../ui/nextjs/lib/project-stream-event.js";
import { monitorAgentActivities } from "../../../ui/nextjs/lib/monitor-agent-activities.js";

// Capture actual SSE frames from each project on a shared event bus to expose missing or conflicting identities.
function connect(projectId, eventBus) {
  const frames = [];
  const response = { write: (chunk) => frames.push(chunk), end() {}, writeHead() {} };
  const stream = createProjectStream({ projectId, indexDb: { all: () => [] }, eventBus,
    subscriptions: { subscribe() { return "subscription"; }, unsubscribe() {} } });
  const connection = stream.connect({ requestedProjectId: projectId, response });
  return { connection, events: () => frames.filter((frame) => frame.startsWith("id:")).map((frame) => JSON.parse(frame.split("data: ")[1])) };
}

test("SDK events without project ids reach only their bound project and pass UI monitor filtering", () => {
  const internalBus = new EventEmitter();
  const first = connect("PROJECT-A", internalBus);
  const second = connect("PROJECT-B", internalBus);
  const messages = [];
  const publish = createUnifiedStreamPublisher({ projectId: "PROJECT-A", internalBus,
    unifiedStreamOrder: createUnifiedStreamOrderer(), bus: { send: (message) => messages.push(message) } });
  try {
    for (const phase of ["tool_started", "tool_completed", "tool_failed"]) {
      const event = { event_type: "agent.activity", task_id: "EXECUTION", conversation_id: "CHAT",
        payload: { conversation_id: "CHAT", agent_id: "ENGINEER", correlation_id: "EXECUTION", activity_type: phase,
          status: phase === "tool_started" ? "working" : phase === "tool_failed" ? "failed" : "success", tool_name: "read_file", summary: "Read project source" } };
      assert.equal(publish(event).project_id, "PROJECT-A");
      assert.equal(event.project_id, undefined);
    }
    const activities = first.events().filter((event) => event.event_type === "agent.activity");
    assert.equal(activities.length, 3);
    assert.ok(activities.every((event) => isProjectStreamEvent(event, "PROJECT-A")));
    assert.equal(monitorAgentActivities(activities, [{ agent_id: "ENGINEER", role: "system_engineer" }], "system_engineer", "ENGINEER").length, 3);
    assert.equal(second.events().filter((event) => event.event_type === "agent.activity").length, 0);
    assert.equal(messages.length, 3);
    assert.ok(messages.every((message) => message.project_id === "PROJECT-A"));
  } finally { first.connection.close(); second.connection.close(); }
});

test("contradictory identities are rejected before emission, persistence or sequence allocation", () => {
  const internalBus = new EventEmitter();
  let emitted = 0;
  internalBus.on("event", () => { emitted += 1; });
  const publish = createUnifiedStreamPublisher({ projectId: "PROJECT-A", internalBus,
    unifiedStreamOrder: createUnifiedStreamOrderer(), bus: { send() { assert.fail("must not persist conflicting events"); } } });
  for (const identity of [{ project_id: "PROJECT-B" }, { metadata: { project_id: "PROJECT-B" } }, { payload: { project_id: "PROJECT-B" } }]) {
    assert.throws(() => publish({ event_type: "agent.activity", task_id: "RUN", ...identity }), { code: "PROJECT_CONTEXT_CONFLICT" });
  }
  assert.equal(emitted, 0);
  assert.equal(publish({ event_type: "agent.activity", task_id: "RUN", project_id: "PROJECT-A" }).sequence, 1);
});
