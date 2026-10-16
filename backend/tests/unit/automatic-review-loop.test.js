// Checks automatic review at the Supervisor event boundary, including distinct completion IDs and normalized repair findings.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { createSupervisorLoop } from "../../src/modules/supervisor/supervisor-loop.js";
import { createSupervisorRuntime } from "../../src/modules/supervisor/supervisor-runtime.js";
import { finalizeCoderWorkspace } from "../../src/modules/supervisor/ticket-coder-completion.js";
import { createTicketReviewRepair } from "../../src/modules/supervisor/ticket-review-repair.js";

// Connects a verified ticket fixture to the real Supervisor finite-state runtime without real provider calls.
function loopFixture(options) {
  const fixture = automaticReviewFixture(options);
  const repairs = [];
  const runtime = createSupervisorRuntime({ taskId: "TICKET-1", supervisorId: "SUP-1", initialState: "VERIFYING", eventBus: fixture.eventBus });
  const claimed = new Set();
  const loop = createSupervisorLoop({ runtime, eventBus: fixture.eventBus, automaticReview: fixture.service,
    requestStore: { claim: async (requestId, type) => { const key = `${requestId}:${type}`; if (claimed.has(key)) return false; claimed.add(key); return true; } },
    sourceRequest: async () => fixture.request, resolveTicketWorkspace: async () => fixture.workspace,
    senderQueue: { enqueue: async (request) => { repairs.push(request); } },
    integrateTicket: (taskId, policy) => finalizeCoderWorkspace(fixture.workspace, taskId, policy) });
  return { ...fixture, runtime, loop, repairs, verification: (attempt = 1) => ({ type: "verification.passed", task_id: "TICKET-1", supervisor_id: "SUP-1", request_id: `VERIFY-${attempt}`, correlation_id: "CORR-1", attempt, payload: {} }) };
}

// Exercises the event-driven path independently of the inline submitTicket completion path.
test("Supervisor hard gate dispatches, repairs normalized findings, approves and integrates", async () => {
  const fixture = loopFixture({ review: async (job, calls) => calls === 1 ? { verdict: "request_changes", findings: [{ failure: "Fix result", severity: "major" }] } : { verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed" }] } });
  await fixture.loop.onEvent(fixture.verification());
  assert.equal(fixture.runtime.getState(), "REVIEWING");
  assert.equal(fixture.order.filter((entry) => entry === "integrate").length, 0);
  await fixture.service.process((await fixture.queueStore.list("agent.request"))[0]);
  await fixture.loop.onEvent(fixture.events.find((event) => event.type === "review.request_changes"));
  assert.equal(fixture.runtime.getState(), "RUNNING");
  assert.equal(fixture.repairs[0].payload.review_findings[0].finding_id, "REV-1");
  fixture.revise();
  await fixture.runtime.transition("VERIFYING", fixture.verification(2));
  await fixture.loop.onEvent(fixture.verification(2));
  const next = (await fixture.queueStore.list("agent.request")).at(-1);
  await fixture.service.process(next);
  const approval = fixture.events.find((event) => event.type === "review.approved");
  await fixture.loop.onEvent(approval);
  assert.equal(fixture.runtime.getState(), "COMPLETED");
  const completion = fixture.events.find((event) => event.type === "task.completed");
  assert(completion);
  assert.notEqual(completion.event_id, approval.event_id);
  assert.equal(completion.payload.completion, "reviewed");
  await fixture.loop.onEvent(approval);
  assert.equal(fixture.order.filter((entry) => entry === "integrate").length, 1);
});

// Makes late adverse soft-gate events informational rather than attempting a transition from COMPLETED.
test("Supervisor soft gate ignores adverse post-completion review for ticket lifecycle", async () => {
  const fixture = loopFixture({ gate: "off", review: async () => ({ verdict: "request_changes", findings: [{ failure: "Late finding" }] }) });
  await fixture.loop.onEvent(fixture.verification());
  assert.equal(fixture.runtime.getState(), "COMPLETED");
  await fixture.service.process((await fixture.queueStore.list("agent.request"))[0]);
  await fixture.loop.onEvent(fixture.events.find((event) => event.type === "review.request_changes"));
  assert.equal(fixture.runtime.getState(), "COMPLETED");
  assert.equal(fixture.repairs.length, 0);
  assert.equal((await fixture.queueStore.list("review.backlog")).length, 1);
});

// Prevents malformed hard-gate configuration from falling through to the soft completion fallback.
test("Supervisor rejects invalid review policy before integration", async () => {
  const fixture = loopFixture();
  fixture.request.ticket.execution_policy.review_gate = "invalid";
  await assert.rejects(fixture.loop.onEvent(fixture.verification()), { code: "REVIEW_POLICY_INVALID" });
  assert.equal(fixture.runtime.getState(), "VERIFYING");
  assert(!fixture.order.includes("integrate"));
});

// Parks infrastructure outages through the real state machine without failing or completing the ticket.
test("Supervisor unavailable Reviewer parks instead of emitting task.failed", async () => {
  const fixture = loopFixture({ review: async () => { throw Object.assign(new Error("Offline"), { code: "REVIEWER_NOT_AVAILABLE" }); } });
  await fixture.loop.onEvent(fixture.verification());
  await fixture.service.process((await fixture.queueStore.list("agent.request"))[0]);
  await fixture.loop.onEvent(fixture.events.find((event) => event.type === "review.unavailable"));
  assert.equal(fixture.runtime.getState(), "NEEDS_HUMAN_REVIEW");
  assert.equal(fixture.events.filter((event) => event.type === "task.needs_human_review").length, 1);
  assert(!fixture.events.some((event) => ["task.failed", "task.completed"].includes(event.type)));
});

// Gives each repair a fresh finding-aware checkpoint and durable handoff before another SDK turn.
test("inline repair runner preserves scope and dispatches findings through fresh resume state", async () => {
  const fixture = automaticReviewFixture();
  const checkpoints = [];
  const queued = [];
  let acknowledged = false;
  const runner = createTicketReviewRepair({ workspace: fixture.workspace, taskId: "TICKET-1", ownerId: "SUP-1", ticket: fixture.request.ticket, selected: { agent_id: "coder-1", provider: "codex" },
    checkpoints: { save: async (value) => checkpoints.push(value), saveReview: async () => {}, complete: async () => {} },
    handoffQueue: { enqueue: async (request) => { queued.push(request); return { id: "REPAIR-JOB" }; }, ack: async () => { acknowledged = true; } },
    execute: async (request) => {
      assert.equal(request.payload.resume_from.review_findings[0].finding_id, "REV-1");
      assert.equal(request.payload.resume_from.thread_id, null);
      assert.equal(request.payload.resume_from.last_completed_turn, 0);
      assert.deepEqual(request.ticket, fixture.request.ticket);
      return { summary: "Repaired" };
    } });
  const result = await runner({ request: fixture.request, findings: [{ finding_id: "REV-1", message: "Fix result" }], outcome: { payload: { findings: [] } } });
  assert.equal(result.request.attempt, 2);
  assert.equal(queued.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(acknowledged, true);
});
