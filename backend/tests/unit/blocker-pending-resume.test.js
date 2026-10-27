// Verifies that an explicitly resumed pending ticket retains blocker decisions, source fences and the original Coder checkpoint.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

// Prepares the same stopped-to-pending transition used by ticket maintenance and resumes through the production RUN dispatcher.
async function resumePending(f) {
  await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
  const current = f.base.statusStore.get();
  f.base.statusStore.updateStatus("TASK", "pending", { ...current.details, reason: "checkpoint_resume_ready" },
    { expectedVersion: current.version, expectedExecutionId: "EXEC" });
  const dispatch = createTicketRunDispatch({ blockerRecovery: f.recovery, checkpoints: f.base.checkpoints,
    ticketStatusStore: f.base.statusStore, disposition: { get: async () => null },
    intake: { open: async () => ({ ticket: f.ticket }) }, sprintRegistry: f.base.registry });
  return dispatch({ projectId: "P", ticketId: "TASK", dependencyExpectations: [] });
}

test("resolved pending ticket continues Coder reporting from its saved turn without another SL call", async () => {
  const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.base.checkpoints.save({ ...checkpoint, last_completed_turn: 36, thread_id: "RETAINED", report_draft: { artifact_id: "PASS" } });
    await f.recovery.tick();
    assert.equal((await resumePending(f)).status, "accepted");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "resumed");
    assert.equal(f.base.invocations, 2);
    assert.deepEqual(f.calls, ["sprint_leader"]);
    const result = await f.base.checkpoints.load("TASK");
    assert.equal(result.thread_id, "RETAINED");
    assert.equal(result.last_completed_turn, 36);
    assert.deepEqual(result.report_draft, { artifact_id: "PASS" });
    assert.equal(f.base.statusStore.get().details.execution_id, "EXEC");
  } finally { await f.close(); }
});

test("pending ticket with an unfinished Architecture consultation resumes AM before Coder", async () => {
  const f = await blockerRecoveryFixture();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    const accepted = await resumePending(f);
    assert.equal(accepted.resumed_stage, "architecture_manager");
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager"]);
    assert.equal(f.base.invocations, 1);
    assert.equal((await f.ledger()).jobs.at(-1).status, "pending");
  } finally { await f.close(); }
});

test("pending status does not authorize a replaced source or execution", async () => {
  for (const mutation of ["staleSource", "replaceExecution", "revokePlan"]) {
    const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => resolution });
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      await f.recovery.tick();
      await resumePending(f);
      f.base[mutation]();
      await f.recovery.tick();
      assert.equal((await f.ledger()).jobs.at(-1).status, "cancelled");
      assert.equal(f.base.invocations, 1);
    } finally { await f.close(); }
  }
});

test("RUN reconciles an orphaned resume_pending projection with its cancelled job", async () => {
  const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    await resumePending(f);
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger();
      Object.assign(ledger.jobs.at(-1), { status: "cancelled", outcome_reason: "stale_execution_or_source" });
      await f.base.store.save("blocker.recovery", ledger);
    });
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.status, "resume_pending");
    const dispatch = createTicketRunDispatch({ blockerRecovery: f.recovery, checkpoints: f.base.checkpoints,
      ticketStatusStore: f.base.statusStore, disposition: { get: async () => null },
      intake: { open: async () => ({ ticket: f.ticket }) }, sprintRegistry: f.base.registry });
    const result = await dispatch({ projectId: "P", ticketId: "TASK", dependencyExpectations: [] });
    assert.equal(result.status, "accepted");
    assert.equal(result.resumed_stage, "coder");
    await f.recovery.tick();
    assert.equal(f.base.invocations, 2);
    assert.deepEqual(f.calls, ["sprint_leader"]);
  } finally { await f.close(); }
});
