// Verifies actual SDK and sender boundaries retain recovery evidence without early terminal publication.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";

test("inline SDK exception returns recovery pending instead of throwing into RUN terminal handling", async () => {
  const failure = Object.assign(new Error("Temporarily unavailable"), { code: "SERVICE_UNAVAILABLE", provider_outcome: "failed", retry_safe: true });
  const decisions = [];
  let checkpoint;
  const integration = createNodeforgeTaskIntegration({ projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => assert.fail("No early terminal event") },
    agentResolver: { resolveAvailable: () => ({ agent_id: "CODER", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB" }) }, toolRegistry: { report_done: { execute: async () => ({}) } },
    checkpointStore: { load: async () => checkpoint, save: async (value) => { checkpoint = value; } },
    runtimeGovernance: { createExecutionContext: (input) => input }, codexSdkGateway: { execute: async () => { throw failure; } },
    coderRecovery: { handleFailure: async (input) => { decisions.push(input); return { handled: true, outcome: "pending" }; } } });
  const result = await integration.submitTicket({ ticket: { id: "TASK", project_id: "PROJECT", execution_policy: { review_gate: "off" }, title: "Fix handler", objective: "Fix handler", acceptance_criteria: ["Handler works"] }, request_id: "REQ" });
  assert.equal(result.status, "recovery_pending");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].error, failure);
  assert.equal(decisions[0].source, "sdk_exception");
  assert.equal(decisions[0].request.request_id, "REQ");
  assert.equal(checkpoint.status, "in_progress");
  assert.equal(checkpoint.phase, "operational_retry_pending");
});

test("sender failure event preserves structured safety evidence, not just SDK error prose", async () => {
  const events = [];
  let acknowledgements = 0;
  const worker = createSenderWorker({ queue: { claim: async () => ({ id: "JOB", task_id: "TASK", request_id: "REQ", payload: {} }), ack: async () => { acknowledgements += 1; } },
    agentRegistry: { resolve: () => ({ adapter: { send: async () => { throw Object.assign(new Error("SDK unavailable"), {
      code: "CONFIGURATION_ERROR", cause: { code: "ECONNRESET" }, provider_outcome: "failed", retry_safe: true }); } } }) },
    eventBus: { publish: async (event) => events.push(event) } });
  await worker.processOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent.response.failed");
  assert.equal(events[0].payload.error.cause.code, "ECONNRESET");
  assert.equal(events[0].payload.error.provider_outcome, "failed");
  assert.equal(events[0].payload.error.retry_safe, true);
  assert.equal(acknowledgements, 1);
});

// Exercises the production Resume wrapper after a durable Stop, preserving the latest checkpoint across a timed retry.
test("production Resume re-arms Stop cancellation before an SDK 503 and retains turn 93", async (t) => {
  const { coderProductionRecoveryFixture, BASIS, TICKET } = await import("../fixtures/coder-production-recovery-fixture.js");
  const f = await coderProductionRecoveryFixture(); t.after(f.close);
  f.restart({ automaticReview: { complete: async () => assert.fail("Failed SDK cannot complete review") } });
  await f.service.cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
  const checkpoint = { task_id: "TASK", status: "failed", last_completed_turn: 93, phase: "review_repair", review_cycle_id: "CYCLE", changed_paths: ["backend/test.js"] };
  await f.checkpoints.save(checkpoint);
  const result = await f.service.runTicket({ ticket: TICKET, task_id: "TASK", project_id: "P", request_id: "OWNER-RESUME", correlation_id: "RESUME-CORR",
    payload: { execution_id: "EXEC", sprint_basis: BASIS, dependency_expectations: [], resume_from: checkpoint, review_cycle_id: "CYCLE" } });
  assert.equal(result.status, "recovery_pending");
  const ledger = (await f.store.list("coder-operational-recovery"))[0];
  assert.equal(ledger.cancelled, false);
  assert.equal(ledger.failures[0].status, "pending");
  assert.equal(ledger.failures[0].request.payload.resume_from.last_completed_turn, 93);
  assert.equal(ledger.failures[0].request.payload.review_cycle_id, "CYCLE");
  f.advance(29_999); await f.service.tick(); assert.equal(f.invocations, 1);
  f.advance(1); await f.service.tick(); assert.equal(f.invocations, 2);
  assert.equal((await f.checkpoints.load("TASK")).last_completed_turn, 93);
});

// Connects explicit RUN to a durable wait for the already parked approval-service outage.
test("parked 503 Resume waits 30 seconds at turn 93 and Stop cancels its polling", async (t) => {
  const { coderProductionRecoveryFixture, TICKET } = await import("../fixtures/coder-production-recovery-fixture.js");
  const f = await coderProductionRecoveryFixture(); t.after(f.close);
  await f.service.stopTicket({ projectId: "P", ticketId: "TASK" });
  const failure = { code: "CODER_BLOCKED", message: "This action was rejected due to unacceptable risk.\nReason: Automatic approval review failed: unexpected status 503 Service Unavailable: system cpu overloaded", at: new Date().toISOString() };
  await f.checkpoints.save({ task_id: "TASK", status: "blocked", failure, last_completed_turn: 93, changed_paths: ["backend/test.js"] });
  const result = await f.service.resumeTicket({ projectId: "P", ticketId: "TASK", ticket: TICKET });
  assert.equal(result.status, "recovery_pending");
  assert.equal(result.resumed_from_turn, 93);
  const checkpoint = await f.checkpoints.load("TASK");
  assert.equal(checkpoint.phase, "operational_retry_pending");
  assert.equal(checkpoint.operational_retry.interval_ms, 30_000);
  f.advance(29_999); await f.service.tick(); assert.equal(f.invocations, 0);
  await f.service.stopTicket({ projectId: "P", ticketId: "TASK" });
  f.advance(60_000); await f.service.tick(); assert.equal(f.invocations, 0);
});

// A real access rejection never becomes an infrastructure retry just because an Owner clicks RUN.
test("parked substantive denial remains outside the 503 retry path", async (t) => {
  const { coderProductionRecoveryFixture, TICKET } = await import("../fixtures/coder-production-recovery-fixture.js");
  const f = await coderProductionRecoveryFixture(); t.after(f.close);
  await f.service.stopTicket({ projectId: "P", ticketId: "TASK" });
  await f.checkpoints.save({ task_id: "TASK", status: "blocked", failure: { code: "CODER_BLOCKED", message: "Policy denied: outside approved scope" } });
  assert.equal(await f.service.resumeTicket({ projectId: "P", ticketId: "TASK", ticket: TICKET }), null);
  assert.equal((await f.store.list("coder-operational-recovery"))[0].cancelled, true);
});
