// Allows uninterrupted SL/Architecture collaboration beyond historical call quotas while preserving execution authority.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { blockerRecoveryPolicy } from "../../src/modules/supervisor/blocker-recovery-policy.js";

// Recreates a retained legacy call-limit failure without resetting its audit history or execution identity.
async function parkLegacyCallLimit(fixture, reason, status = "reconciliation_required") {
  await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
  await fixture.base.store.withLock("blocker.recovery", async () => {
    const ledger = await fixture.ledger();
    ledger.calls = 5;
    ledger.policy.max_calls = 5;
    const job = ledger.jobs[0];
    job.stage = "architecture_manager";
    job.status = status;
    job.outcome_reason = reason;
    await fixture.base.store.save("blocker.recovery", ledger);
  });
}

test("deployment policy ignores retired call and resume quotas but validates deadlines", () => {
  for (const maxCalls of ["1", "5", "invalid"]) {
    assert.deepEqual(blockerRecoveryPolicy({ NODEFORGE_BLOCKER_MAX_CALLS: maxCalls, NODEFORGE_BLOCKER_MAX_RESUMES: "invalid" }), { deadlineMs: 3_600_000 });
  }
  assert.throws(() => blockerRecoveryPolicy({ NODEFORGE_BLOCKER_DEADLINE_MS: "invalid" }));
});

test("SL consumes the fifth historical call and AM still runs after restart", async () => {
  const fixture = await blockerRecoveryFixture({ limits: { maxCalls: 1 } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.equal(Object.hasOwn((await fixture.ledger()).policy, "max_calls"), false);
    await fixture.base.store.withLock("blocker.recovery", async () => {
      const ledger = await fixture.ledger();
      ledger.calls = 4;
      ledger.policy.max_calls = 5;
      await fixture.base.store.save("blocker.recovery", ledger);
    });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).calls, 5);
    await fixture.recreate().tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);
    assert.equal((await fixture.ledger()).calls, 6);
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
    assert.equal(fixture.base.integrations, 1);
    assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
  } finally { await fixture.close(); }
});

test("owner follow-up re-arms AM without allocating another call quota", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await parkLegacyCallLimit(fixture, "authority_required", "owner_required");
    const jobId = (await fixture.ledger()).jobs[0].id;
    const job = await fixture.recovery.followOwnerDecision({ projectId: "P", taskId: "TASK", executionId: "EXEC", jobId,
      decision: { decision_id: "CHOICE", actor: "OWNER", option_id: "continue" } });
    assert.equal(job.status, "pending");
    assert.equal(job.stage, "architecture_manager");
    assert.equal((await fixture.ledger()).policy.max_calls, 5);
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["architecture_manager"]);
    assert.equal((await fixture.ledger()).calls, 6);
  } finally { await fixture.close(); }
});

for (const reason of ["triage_budget_exhausted", "disposition_correction_budget_exhausted"]) {
  for (const status of ["reconciliation_required", "notification_pending"]) {
    test(`legacy ${reason} at ${status} resumes AM automatically without rerunning SL`, async () => {
      const fixture = await blockerRecoveryFixture();
      try {
        await parkLegacyCallLimit(fixture, reason, status);
        await fixture.recreate().tick();
        const ledger = await fixture.ledger();
        assert.deepEqual(fixture.calls, ["architecture_manager"]);
        assert.equal(ledger.calls, 6);
        assert.equal(ledger.jobs[0].history[0].event, "call_limit_removed");
        assert.equal(ledger.jobs[0].history[0].previous_outcome_reason, reason);
        await fixture.recovery.tick();
        await fixture.recovery.tick();
        assert.equal(fixture.base.integrations, 1);
      } finally { await fixture.close(); }
    });
  }
}

for (const boundary of ["cancelled", "expired", "stale", "unknown_provider"]) {
  test(`removing call limits does not bypass the ${boundary} boundary`, async () => {
    const fixture = await blockerRecoveryFixture();
    try {
      await parkLegacyCallLimit(fixture, boundary === "unknown_provider" ? "provider_outcome_unknown" : "triage_budget_exhausted",
        boundary === "cancelled" ? "notification_pending" : "reconciliation_required");
      if (boundary === "cancelled") await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      if (boundary === "expired") fixture.advance(600_000);
      if (boundary === "stale") fixture.base.staleSource();
      await fixture.recreate().tick();
      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.base.invocations, 1);
      assert.equal(fixture.base.integrations, 0);
      assert.notEqual((await fixture.ledger()).jobs[0].status, "pending");
    } finally { await fixture.close(); }
  });
}
