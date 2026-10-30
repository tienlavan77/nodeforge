// Verifies unavailable approval services retry checkpoint work every 30 seconds until recovery or owner Stop.
import assert from "node:assert/strict";
import test from "node:test";
import { approvalServiceUnavailable, scheduleApprovalRetry } from "../../src/modules/supervisor/blocker/blocker-approval-retry.js";
import { assertTicketExecutionCompleted } from "../../src/modules/supervisor/nodeforge-task-sdk-events.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket/ticket-resume.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";

const receipt = { event_id: "SERVICE-503", tool: "write_diff", arguments: { path: "backend/tests/support.js" }, error: {
  message: "This action was rejected due to unacceptable risk.\nReason: Automatic approval review failed: unexpected status 503 Service Unavailable: system cpu overloaded\nThe agent must not attempt a workaround." } };
const evidence = { status: "captured", receipts: [receipt] };

// Runs the real checkpoint/status/queue integration with controlled service responses and a deterministic clock.
async function fixture(options = {}) {
  const logs = [];
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", ...options,
    recoveryOptions: { readFailureEvidence: async () => evidence, projectLogger: (entry) => logs.push(entry), ...options.recoveryOptions } });
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  return { ...f, logs };
}

test("only the original approval-provider 503 qualifies; policy rejection and incidental 503 text do not", () => {
  assert(approvalServiceUnavailable(receipt));
  for (const message of ["Policy denied: unsafe access, HTTP 503 mentioned in source.", "Automatic approval review failed: unexpected status 401 Unauthorized",
    "This action was rejected due to unacceptable risk.\nReason: Scope expansion.", "Agent says the service might be 503."]) {
    assert.equal(approvalServiceUnavailable({ error: { message } }), false);
  }
  const job = { status: "reconciliation_required", stage: "sprint_leader", history: [], execution_admission: { decision: { verdict: "deny" } } };
  assert.equal(scheduleApprovalRetry(job, { receipts: [receipt] }, 1000), false);
  assert.equal(job.status, "reconciliation_required");
});

test("SDK approval outage before report_done enters service recovery with its original diagnostic", () => {
  assert.throws(() => assertTicketExecutionCompleted([{ tool: "write_diff", status: "failed", error: receipt.error }]),
    (error) => error.code === "CODER_BLOCKED" && error.details.blocker.reason_code === "ACCESS_REQUIRED" && error.message.includes("503"));
});

test("dashboard checkpoint exposes a pending retry without presenting it as manual Resume", async () => {
  const routes = createForgeV1ConversationRoutes({ listResumableCheckpoints: async () => [{ task_id: "T", status: "blocked",
    phase: "approval_retry_pending", last_completed_turn: 97, blocker_recovery: { status: "approval_retry_pending",
      approval_retry: { interval_ms: 30_000, available_at: 31_000, receipts: [receipt] } } }] });
  const result = await routes.withCheckpointSummary([{ id: "S", tickets: [{ id: "T" }] }]);
  const checkpoint = result[0].tickets[0].checkpoint;
  assert.equal(checkpoint.resumable, false);
  assert.deepEqual(checkpoint.approval_retry, { interval_ms: 30_000, available_at: 31_000 });
  assert.equal(checkpoint.last_completed_turn, 97);
});

test("503 waits exactly 30 seconds then resumes Coder directly with no SL/AM call", async (context) => {
  const f = await fixture(); context.after(f.close);
  const first = (await f.ledger()).jobs.at(-1);
  assert.equal(first.status, "approval_retry_pending");
  assert.equal(first.approval_retry.interval_ms, 30_000);
  const checkpoint = await f.base.checkpoints.load("TASK");
  assert.equal(checkpoint.phase, "approval_retry_pending");
  assert.match(f.logs.at(-1).message, /30 giây.*Stop/);
  assert.deepEqual(checkpoint.blocker_recovery.approval_retry.receipts, [receipt]);
  f.advance(29_999); await f.recovery.tick(); assert.equal(f.base.invocations, 1);
  f.advance(1); await f.recovery.tick();
  assert.equal(f.base.invocations, 2);
  assert.deepEqual(f.calls, []);
  assert.equal(f.base.statusStore.get("TASK").status, "done");
  assert.equal((await f.ledger()).jobs.at(-1).status, "resumed");
  assert.equal(f.base.events.filter((event) => event.type === "task.completed").length, 1);
});

test("Stop cancels a waiting retry and restart cannot dispatch it", async (context) => {
  const f = await fixture(); context.after(f.close);
  await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
  assert.equal((await f.ledger()).cancelled, true);
  f.recreate({ readFailureEvidence: async () => evidence });
  f.advance(60_000); await f.recovery.recover(); await f.recovery.tick();
  assert.equal(f.base.invocations, 1);
  assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.status, "cancelled");
});

test("explicit Resume after Stop re-arms the same checkpoint with a fresh 30-second wait", async (context) => {
  const f = await fixture(); context.after(f.close);
  await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
  const result = await f.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
  assert.equal(result.resumed_stage, "coder");
  f.advance(29_999); await f.recovery.tick(); assert.equal(f.base.invocations, 1);
  f.advance(1); await f.recovery.tick(); assert.equal(f.base.invocations, 2);
  assert.deepEqual(f.calls, []);
});

test("restart retains the original due time and same execution instead of resetting the wait", async (context) => {
  const f = await fixture(); context.after(f.close);
  const first = (await f.ledger()).jobs.at(-1);
  f.advance(20_000);
  const recovery = f.recreate({ readFailureEvidence: async () => evidence });
  await recovery.recover();
  assert.equal((await f.ledger()).jobs.at(-1).approval_retry.available_at, first.approval_retry.available_at);
  f.advance(10_000); await recovery.tick();
  assert.equal(f.base.invocations, 2);
  assert.equal((await f.ledger()).execution_id, "EXEC");
});

test("source or approval changes invalidate a due retry before any provider call", async (context) => {
  const f = await fixture(); context.after(f.close);
  f.base.staleSource(); f.advance(30_000); await f.recovery.tick();
  assert.equal(f.base.invocations, 1);
  assert.equal((await f.ledger()).jobs.at(-1).status, "cancelled");
});

test("two recovery workers reserve only one provider retry", async (context) => {
  const f = await fixture(); context.after(f.close);
  const other = f.recreate({ readFailureEvidence: async () => evidence });
  f.advance(30_000);
  await Promise.all([f.recovery.tick(), other.tick()]);
  assert.equal(f.base.invocations, 2);
});

test("a genuine rejection after service recovery is not retried as another 503", async (context) => {
  let temporary = true;
  const f = await fixture({ repeatBlock: true, recoveryOptions: { readFailureEvidence: async () => temporary ? evidence
    : { status: "captured", receipts: [{ ...receipt, error: { message: "This action was rejected due to unacceptable risk.\nReason: Access outside the approved scope." } }] } } });
  context.after(f.close);
  temporary = false;
  f.advance(30_000); await f.recovery.tick();
  assert.equal(f.base.invocations, 2);
  assert.equal((await f.ledger()).jobs.at(-1).approval_retry, undefined);
});

test("recurring 503 schedules another 30-second wait without exhausting the SL deadline", async (context) => {
  const f = await fixture({ repeatBlock: true }); context.after(f.close);
  f.advance(700_000); await f.recovery.tick();
  assert.equal(f.base.invocations, 2);
  const next = (await f.ledger()).jobs.at(-1);
  assert.equal(next.status, "approval_retry_pending");
  f.advance(29_999); await f.recovery.tick(); assert.equal(f.base.invocations, 2);
  f.advance(1); await f.recovery.tick(); assert.equal(f.base.invocations, 3);
  assert.deepEqual(f.calls, []);
});

test("an already parked 503 is recovered after deployment; a real denial remains parked", async (context) => {
  let availableEvidence = { status: "missing", receipts: [] };
  const f = await fixture({ recoveryOptions: { readFailureEvidence: async () => availableEvidence } }); context.after(f.close);
  assert.equal((await f.ledger()).jobs.at(-1).status, "pending");
  availableEvidence = evidence;
  await f.recovery.recover();
  assert.equal((await f.ledger()).jobs.at(-1).status, "approval_retry_pending");
  const state = createResumeState({ status: "blocked", last_completed_turn: 97, thread_id: "SAVED",
    blocker_recovery: { status: "approval_retry", approval_retry: { receipts: [receipt] } } });
  assert.equal(state.threadId, "SAVED");
  const prompt = buildResumePrompt("Implement the remaining checks", state);
  assert.match(prompt, /turn 97/);
  assert.match(prompt, /unchanged tool approval path/);
  assert.doesNotMatch(prompt, /never retry a denied operation/);
});

test("partial receipts or a real rejection alongside 503 cannot arm automatic retry", async (context) => {
  const f = await fixture({ recoveryOptions: { readFailureEvidence: async () => ({ ...evidence, receipts: [receipt,
    { ...receipt, error: { message: "This action was rejected due to unacceptable risk.\nReason: New policy required." } }] }) } });
  context.after(f.close);
  assert.equal((await f.ledger()).jobs.at(-1).status, "pending");
});
