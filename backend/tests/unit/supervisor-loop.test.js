import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorLoop } from "../../src/modules/supervisor/supervisor-loop.js";

function harness({ initialState = "CREATED" } = {}) {
  const transitions = [];
  let state = initialState;
  const runtime = {
    taskId: "TASK-1",
    supervisorId: "SUP-1",
    getState: () => state,
    async transition(next) { transitions.push([state, next]); state = next; return next; }
  };
  const sent = [];
  const collected = [];
  const verified = [];
  const published = [];
  const senderQueue = { enqueue: async (job) => sent.push(job) };
  const collectorQueue = { enqueue: async (job) => collected.push(job) };
  const verificationQueue = { enqueue: async (job) => verified.push(job) };
  const eventBus = { publish: async (event) => published.push(event) };
  const attemptBuilder = {
    onResponse: async () => {},
    requestRepair: async (source) => ({ request_id: `REQ-REPAIR-${source.request_id ?? "x"}`, payload: { step_id: 2 } })
  };
  const loop = createSupervisorLoop({ runtime, senderQueue, collectorQueue, verificationQueue, eventBus, attemptBuilder });
  return { loop, runtime, transitions, sent, collected, verified, published, attemptBuilder, stateOf: () => state };
}

function baseEvent(overrides = {}) {
  return { type: "agent.response.received", task_id: "TASK-1", supervisor_id: "SUP-1", request_id: "REQ-1", correlation_id: "CORR-1", attempt: 1, payload: {}, ...overrides };
}

test("start dispatches attempt 1 through RUNNING", async () => {
  const h = harness();
  const request = { task_id: "TASK-1", request_id: "REQ-1", correlation_id: "CORR-1", agent_id: "builder", ticket: { project_id: "P", id: "TASK-1", title: "T", objective: "O", acceptance_criteria: ["A"] } };
  await h.loop.start(request);
  assert.deepEqual(h.transitions, [["CREATED", "RUNNING"]]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].agent_id, "builder");
});

test("agent response enqueues the collector and moves to VERIFYING", async () => {
  const h = harness({ initialState: "RUNNING" });
  const result = await h.loop.onEvent(baseEvent({ payload: { response: { type: "session.result", summary: "done" } } }));
  assert.equal(result, true);
  assert.deepEqual(h.transitions, [["RUNNING", "VERIFYING"]]);
  assert.equal(h.collected.length, 1);
  assert.equal(h.collected[0].request_id, "REQ-1");
});

test("changeset with files flows to verification", async () => {
  const h = harness({ initialState: "VERIFYING" });
  const result = await h.loop.onEvent(baseEvent({ type: "changeset.collected", payload: { changed_paths: ["src/a.js"], checksums: { "src/a.js": "sha256:abc" }, empty: false } }));
  assert.equal(result.handled, true);
  assert.equal(h.verified.length, 1);
  assert.equal(h.verified[0].changed_paths.length, 1);
  assert.deepEqual(h.transitions, []);
});

test("empty changeset opens a repair attempt instead of verification", async () => {
  const h = harness({ initialState: "VERIFYING" });
  const result = await h.loop.onEvent(baseEvent({ type: "changeset.collected", payload: { changed_paths: [], checksums: {}, empty: true } }));
  assert.equal(result.handled, true);
  assert.equal(h.verified.length, 0);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.transitions, [["VERIFYING", "REPAIRING"], ["REPAIRING", "RUNNING"]]);
});

test("verification.passed completes the task and publishes task.completed", async () => {
  const h = harness({ initialState: "VERIFYING" });
  await h.loop.onEvent(baseEvent({ type: "verification.passed" }));
  assert.deepEqual(h.transitions, [["VERIFYING", "COMPLETED"]]);
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].type, "task.completed");
});

test("verification.failed opens a repair attempt back to RUNNING", async () => {
  const h = harness({ initialState: "VERIFYING" });
  await h.loop.onEvent(baseEvent({ type: "verification.failed", payload: { failed_paths: ["src/a.js"] } }));
  assert.deepEqual(h.transitions, [["VERIFYING", "REPAIRING"], ["REPAIRING", "RUNNING"]]);
  assert.equal(h.sent.length, 1);
});

test("agent.response.failed terminates with task.failed", async () => {
  const h = harness({ initialState: "RUNNING" });
  await h.loop.onEvent(baseEvent({ type: "agent.response.failed", payload: { error: { code: "AGENT_REQUEST_FAILED", message: "down" } } }));
  assert.deepEqual(h.transitions, [["RUNNING", "FAILED"]]);
  assert.equal(h.published[0].type, "task.failed");
});

test("events for other supervisors are ignored", async () => {
  const h = harness({ initialState: "RUNNING" });
  assert.equal(await h.loop.onEvent(baseEvent({ supervisor_id: "SUP-OTHER" })), false);
  assert.deepEqual(h.transitions, []);
});
