import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeService } from "../../src/application/runtime-service.js";
import { createEventStore } from "../../src/modules/events/event-store.js";

function sessionStore() {
  const sessions = new Map();
  return { save(session) { const snapshot = session.getSnapshot(); sessions.set(snapshot.id, { ...snapshot }); return { ...snapshot }; }, load(id) { const session = sessions.get(id); return session ? { ...session } : undefined; }, loadAll() { return [...sessions.values()].map((session) => ({ ...session })); } };
}

test("starts, pauses, resumes, reads a session, and retrieves project memory", () => {
  const service = createRuntimeService({
    createSessionId: () => "SESSION-104",
    sessionStore: sessionStore(),
    eventStore: createEventStore(),
    memoryRetriever: {
      retrieve(input) {
        assert.deepEqual(input, { projectId: "PROJECT-104", taskId: "TASK-104", query: "auth", domain: "security" });
        return { project_id: input.projectId, task_id: input.taskId, source: "project_memory", relevant_facts: ["Auth migrated to v2."] };
      }
    }
  });

  assert.equal(service.startTask({ projectId: "PROJECT-104", taskId: "TASK-104" }).state, "RUNNING");
  assert.equal(service.pauseSession("SESSION-104").state, "PAUSED");
  assert.equal(service.getSession("SESSION-104").state, "PAUSED");
  assert.equal(service.resumeSession("SESSION-104").state, "RUNNING");
  assert.deepEqual(service.getProjectMemory({ projectId: "PROJECT-104", taskId: "TASK-104", query: "auth", domain: "security" }).relevant_facts, ["Auth migrated to v2."]);
});

test("rejects unknown sessions and duplicate session IDs", () => {
  const service = createRuntimeService({ createSessionId: () => "SESSION-104", sessionStore: sessionStore(), eventStore: createEventStore(), memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) } });
  assert.throws(() => service.getSession("SESSION-missing"), /Unknown Agent Session/);
  service.startTask({ projectId: "PROJECT-104", taskId: "TASK-104" });
  assert.throws(() => service.startTask({ projectId: "PROJECT-104", taskId: "TASK-104" }), /Session already exists/);
});

test("starts Agent execution asynchronously and publishes completion or failure", async () => {
  const events = [];
  let resolveRun;
  const service = createRuntimeService({ createSessionId: () => "SESSION-ASYNC", sessionStore: sessionStore(), eventStore: createEventStore(), memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) }, agentRuntime: { run: (input) => { assert.deepEqual(input, { projectId: "PROJECT-ASYNC", taskId: "TASK-ASYNC", query: "refresh", domain: "runtime" }); return new Promise((resolve) => { resolveRun = resolve; }); } }, publisher: { publish: (event) => events.push(event) } });
  const snapshot = service.startTask({ projectId: "PROJECT-ASYNC", taskId: "TASK-ASYNC", query: "refresh", domain: "runtime" });
  assert.equal(snapshot.state, "RUNNING");
  assert.equal(events.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  resolveRun({ status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0].type, "agent.completed");
  assert.equal(events[0].metadata.session_id, "SESSION-ASYNC");
});

test("Agent failure is published without rejecting startTask", async () => {
  const events = [];
  const service = createRuntimeService({ createSessionId: () => "SESSION-FAILED", sessionStore: sessionStore(), eventStore: createEventStore(), memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) }, agentRuntime: { run: async () => { throw new Error("agent unavailable"); } }, publisher: { publish: (event) => events.push(event) }, logger: { error() {} } });
  assert.equal(service.startTask({ projectId: "PROJECT-FAILED", taskId: "TASK-FAILED" }).state, "RUNNING");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0].type, "agent.failed");
  assert.equal(events[0].payload.error, "agent unavailable");
});
