// Prevents repeated RUN from rejecting or relaunching recovery that already owns a ticket execution.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Reproduces automatic wake-up racing with an owner's Resume on an obsolete parked checkpoint.
test("Resume acknowledges pending and invoking recovery without replaying the provider or rewriting its checkpoint", async () => {
  let started;
  let finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const release = new Promise((resolve) => { finish = resolve; });
  const fixture = await blockerRecoveryFixture({ investigate: async (_job, resolution) => {
    started();
    await release;
    return resolution;
  } });
  let tick;
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    await fixture.base.checkpoints.save({ ...checkpoint, phase: "blocker_reconciliation_required",
      blocker_recovery: { ...checkpoint.blocker_recovery, status: "reconciliation_required", reason: "disposition_correction_no_progress" } });
    assert.equal((await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" })).status, "already_running");
    tick = fixture.recovery.tick();
    await entered;
    const before = await fixture.base.checkpoints.load("TASK");
    const ledger = await fixture.ledger();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
      assert.equal(result.status, "already_running");
      assert.equal(result.execution_id, "EXEC");
    }
    assert.deepEqual(await fixture.base.checkpoints.load("TASK"), before);
    assert.deepEqual(await fixture.ledger(), ledger);
    assert.deepEqual(fixture.calls, ["sprint_leader"]);
    assert.equal(fixture.base.invocations, 1);
    await assert.rejects(fixture.recovery.resumeTicket({ projectId: "OTHER", ticketId: "TASK" }), /different project/);
    finish();
    await tick;
    assert.equal((await fixture.ledger()).jobs.at(-1).status, "resume_pending");
    assert.equal((await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" })).status, "already_running");
  } finally {
    finish();
    if (tick) await tick;
    await fixture.close();
  }
});
