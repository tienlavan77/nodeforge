// Preserves deadlines, Stop boundaries and provider ownership without limiting SL/Architecture coordination calls.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

test("the execution deadline does not reset after restart", async () => {
  const fixture = await blockerRecoveryFixture({ limits: { deadlineMs: 1000 } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    fixture.advance(1000);
    await fixture.recovery.tick(); await fixture.recreate().tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.calls.length, 0);
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "reconciliation_required");
    assert.equal(job.outcome_reason, "triage_deadline_exhausted");
  } finally { await fixture.close(); }
});

test("unavailable roles wait without consuming provider calls until the deadline", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => { throw Object.assign(new Error("Role busy"), { not_started: true }); } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).calls, 0);
    fixture.advance(600_000); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
  } finally { await fixture.close(); }
});

test("repeated blockers can resume Coder beyond legacy quotas without resetting the execution", async () => {
  const fixture = await blockerRecoveryFixture({ repeatBlock: true, limits: { maxResumes: 1 } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 16; turn += 1) await fixture.recreate().tick();
    const ledger = await fixture.ledger();
    assert.equal(fixture.base.invocations, 5);
    assert.equal(ledger.resumes, 4);
    assert.equal(ledger.calls, 12);
    assert.deepEqual(fixture.calls, Array.from({ length: 4 }, () => ["sprint_leader", "architecture_manager", "sprint_leader"]).flat());
    assert.equal(ledger.jobs.at(-1).status, "pending");
    assert.equal(Object.hasOwn(ledger.policy, "max_resumes"), false);
    assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("a crash after the stage claim never redispatches that provider invocation", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const ledger = await fixture.ledger();
    ledger.jobs[0].status = "invoking";
    ledger.calls = 1;
    await fixture.base.store.withLock("blocker.recovery", () => fixture.base.store.save("blocker.recovery", ledger));
    await fixture.recreate().tick();
    assert.equal(fixture.calls.length, 0);
    fixture.advance(600_000);
    await fixture.recovery.tick();
    assert.equal(fixture.calls.length, 0);
    assert.equal((await fixture.ledger()).jobs[0].outcome_reason, "provider_outcome_unknown");
    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed, true);
    assert.equal(fixture.calls.length, 0, "RUN must not replay the provider during the resume itself");
  } finally { await fixture.close(); }
});
