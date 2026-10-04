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

// Keeps the Coder claimed through a repair, then completes without an inline Reviewer.
test("Supervisor releases Coder after verified integration without review dispatch", async () => {
  const h = harness();
  let active;
  const releases = [];
  const reviews = [];
  const agentOccupancy = {
    getByTask: () => active,
    claim: async ({ agentId, taskId, supervisorId }) => { active ??= { claim_id: "CLAIM-1", agent_id: agentId, task_id: taskId, supervisor_id: supervisorId }; return active; },
    release: async (input) => { releases.push(input); active = null; }
  };
  const loop = createSupervisorLoop({ runtime: h.runtime, senderQueue: { enqueue: async (request) => { h.sent.push(request); if (request.operation === "review") reviews.push(request); } }, collectorQueue: { enqueue: async () => {} }, verificationQueue: { enqueue: async () => {} }, eventBus: { publish: async (event) => h.published.push(event) }, attemptBuilder: h.attemptBuilder, agentOccupancy, integrateTicket: async () => {} });
  await loop.start({ task_id: "TASK-1", request_id: "REQ-1", correlation_id: "CORR-1", agent_id: "coder-1", required_role: "coder" });
  await loop.onEvent(baseEvent({ type: "agent.response.received" }));
  await loop.onEvent(baseEvent({ type: "verification.failed" }));
  assert.equal(active.agent_id, "coder-1");
  await loop.onEvent(baseEvent({ type: "agent.response.received", request_id: "REQ-2" }));
  await loop.onEvent(baseEvent({ type: "verification.passed", request_id: "REQ-2", attempt: 2, payload: { changed_paths: ["src/a.js"] } }));
  assert.equal(h.stateOf(), "COMPLETED");
  assert.equal(reviews.length, 0);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, "coder_completed");
  assert.equal(h.published.at(-1).type, "task.completed");
});

// Prevents acceptance when the reviewed worktree commit cannot reach the root branch.
test("Supervisor records approved-review integration failure as resumable", async () => {
  const h = harness({ initialState: "REVIEWING" });
  const releases = [];
  const agentOccupancy = { getByTask: () => ({ claim_id: "CLAIM-1", agent_id: "coder-1" }), release: async (input) => releases.push(input) };
  const loop = createSupervisorLoop({ runtime: h.runtime, eventBus: { publish: async (event) => h.published.push(event) }, agentOccupancy, integrateTicket: async () => { throw Object.assign(new Error("conflict"), { code: "TICKET_INTEGRATION_CONFLICT" }); } });
  await loop.onEvent(baseEvent({ type: "review.approved", request_id: "REVIEW-1", payload: { reviewer_id: "reviewer-1", verdict: "approved" } }));
  assert.equal(h.stateOf(), "FAILED");
  assert.equal(h.published[0].type, "task.failed");
  assert.equal(h.published[0].payload.reason, "TICKET_INTEGRATION_CONFLICT");
  assert.equal(releases[0].reason, "TICKET_INTEGRATION_CONFLICT");
});

// Keeps a repeated approved event from integrating or releasing the same ticket twice.
test("duplicate Reviewer approval event has one terminal effect", async () => {
  const h = harness({ initialState: "REVIEWING" });
  const seen = new Set();
  let integrations = 0;
  let releases = 0;
  const loop = createSupervisorLoop({
    runtime: h.runtime,
    eventBus: { publish: async (event) => h.published.push(event) },
    requestStore: { claim: async (requestId, type) => { const key = `${requestId}:${type}`; if (seen.has(key)) return false; seen.add(key); return true; } },
    agentOccupancy: { getByTask: () => ({ claim_id: "CLAIM-1", agent_id: "coder-1" }), release: async () => { releases += 1; } },
    integrateTicket: async () => { integrations += 1; }
  });
  const approval = baseEvent({ type: "review.approved", request_id: "REVIEW-SAME", payload: { reviewer_id: "reviewer-1", verdict: "approved" } });
  await loop.onEvent(approval);
  await loop.onEvent(approval);
  assert.equal(h.stateOf(), "COMPLETED");
  assert.equal(integrations, 1);
  assert.equal(releases, 1);
  assert.equal(h.published.filter((event) => event.type === "task.completed").length, 1);
});

// A waiting ticket can retry when a Coder becomes ready without losing its request id.
test("unavailable Coder does not consume start idempotency", async () => {
  const h = harness();
  let ready = false;
  const claimed = [];
  const loop = createSupervisorLoop({ runtime: h.runtime, senderQueue: { enqueue: async (request) => h.sent.push(request) }, eventBus: { publish: async () => {} }, agentResolver: { resolveAvailable: () => ({ agent_id: "coder-1", role: "coder" }), list: () => [{ agent_id: "coder-1" }] }, agentOccupancy: { getByTask: () => null, claim: async () => ready ? { claim_id: "CLAIM-1" } : null }, requestStore: { claim: async (...args) => { claimed.push(args); return true; } } });
  const request = { task_id: "TASK-1", request_id: "REQ-WAIT", required_role: "coder" };
  await assert.rejects(() => loop.start(request), (error) => error.code === "AGENT_NOT_AVAILABLE");
  assert.equal(claimed.length, 0);
  ready = true;
  await loop.start(request);
  assert.equal(claimed.length, 1);
  assert.equal(h.sent.length, 1);
});
