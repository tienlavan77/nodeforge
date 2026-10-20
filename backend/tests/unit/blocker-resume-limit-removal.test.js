// Resumes ticket collaboration beyond historical Coder quotas without replaying unverified or cancelled work.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Retains an accepted AM disposition at the old two-resume quota for deployment recovery checks.
async function parkLegacyResumeLimit(fixture, status = "reconciliation_required") {
  await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
  await fixture.recovery.tick(); await fixture.recovery.tick();
  await fixture.base.store.withLock("blocker.recovery", async () => {
    const ledger = await fixture.ledger();
    ledger.resumes = 2;
    ledger.policy.max_resumes = 2;
    ledger.jobs[0].status = status;
    ledger.jobs[0].outcome_reason = "resume_budget_exhausted";
    await fixture.base.store.save("blocker.recovery", ledger);
  });
}

for (const status of ["reconciliation_required", "notification_pending"]) {
  test(`legacy resume quota at ${status} SL consumes the retained AM answer before the third Coder resume`, async () => {
    const fixture = await blockerRecoveryFixture();
    try {
      await parkLegacyResumeLimit(fixture, status);
      await fixture.recreate().tick();
      const ledger = await fixture.ledger();
      assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
      assert.equal(fixture.base.invocations, 1);
      assert.equal(ledger.resumes, 2);
      assert.equal(ledger.jobs[0].status, "resume_pending");
      const migration = ledger.jobs[0].history.find((entry) => entry.event === "resume_limit_removed");
      assert.equal(migration.previous_outcome_reason, "resume_budget_exhausted");
      assert.equal(migration.previous_resolution.action, "resolved");
      await fixture.recovery.tick();
      assert.equal((await fixture.ledger()).resumes, 3);
      assert.equal(fixture.base.invocations, 2);
      assert.equal(fixture.base.integrations, 1);
      assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
    } finally { await fixture.close(); }
  });
}

test("rechecking a cached resolution can retain an unresolved technical prerequisite without calling Coder", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await parkLegacyResumeLimit(fixture);
    fixture.recreate({ investigate: async () => ({ action: "reconciliation_required", summary: "The serving-handler claim is still held.",
      guidance: "Reconcile the existing claim before authorizing execution." }) });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    const ledger = await fixture.ledger();
    assert.equal(ledger.resumes, 2);
    assert.equal(ledger.jobs[0].status, "reconciliation_required");
    assert.equal(ledger.jobs[0].outcome_reason, "technical_reconciliation_no_progress");
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

for (const boundary of ["cancelled", "expired", "stale", "unknown_provider", "unresolved"]) {
  test(`removing the legacy resume quota respects ${boundary} work`, async () => {
    const fixture = await blockerRecoveryFixture();
    try {
      await parkLegacyResumeLimit(fixture, boundary === "cancelled" ? "notification_pending" : "reconciliation_required");
      if (boundary === "cancelled") await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      if (boundary === "expired") fixture.advance(600_000);
      if (boundary === "stale") fixture.base.staleSource();
      if (["unknown_provider", "unresolved"].includes(boundary)) await fixture.base.store.withLock("blocker.recovery", async () => {
        const ledger = await fixture.ledger();
        if (boundary === "unknown_provider") ledger.jobs[0].outcome_reason = "provider_outcome_unknown";
        else delete ledger.jobs[0].resolution;
        await fixture.base.store.save("blocker.recovery", ledger);
      });
      await fixture.recreate().tick();
      assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);
      assert.equal((await fixture.ledger()).resumes, 2);
      assert.equal(fixture.base.invocations, 1);
      assert.equal(fixture.base.integrations, 0);
    } finally { await fixture.close(); }
  });
}

test("a verified Coder resume still observes the actual deadline, not a count quota", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    fixture.advance(600_000);
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].outcome_reason, "resume_deadline_exhausted");
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});
