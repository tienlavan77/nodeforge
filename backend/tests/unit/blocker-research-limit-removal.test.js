// Verifies removal of research quotas preserves existing execution boundaries and retained AM checkpoints.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Models persisted recovery data produced before research quotas were removed.
async function parkResearchLimit(fixture, status = "reconciliation_required") {
  await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
  await fixture.recovery.tick();
  await fixture.base.store.withLock("blocker.recovery", async () => {
    const ledger = await fixture.ledger();
    const job = ledger.jobs[0];
    job.status = status;
    job.outcome_reason = "technical_reconciliation_rounds_exhausted";
    job.technical_reconciliation = { round: 3, max_rounds: 3, fingerprints: [],
      work: { prerequisite: "Finish retained source comparison" }, assigned_role: "architecture_manager" };
    await fixture.base.store.save("blocker.recovery", ledger);
  });
}

for (const status of ["reconciliation_required", "notification_pending"]) {
  test(`legacy research quota at ${status} continues AM without resetting the execution`, async () => {
    const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
      if (job.stage === "sprint_leader") return job.architecture_response?.disposition ?? { action: "architecture_required", summary: "Inspect source." };
      assert.equal(job.technical_reconciliation.max_rounds, null);
      assert.equal(job.technical_reconciliation.round, 3);
      return { ...resolution, technical_result: { findings: ["Compared the existing source."],
        implementation_steps: ["Finish the approved handler."], verification_steps: ["Run focused handler tests."],
        admission: { status: "within_existing_permissions", rationale: "No denied operation is required." } } };
    } });
    try {
      await parkResearchLimit(fixture, status);
      const deadline = (await fixture.ledger()).deadline_at;
      await fixture.recreate().tick();
      assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);
      const ledger = await fixture.ledger();
      assert.equal(ledger.deadline_at, deadline);
      assert.equal(ledger.jobs[0].status, "pending");
      assert.equal(ledger.jobs[0].stage, "sprint_leader");
      assert(ledger.jobs[0].history.some((entry) => entry.previous_outcome_reason === "technical_reconciliation_rounds_exhausted"));
      await fixture.recovery.tick();
      assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
      await fixture.recovery.tick();
      assert.equal(fixture.base.integrations, 1);
      assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
    } finally { await fixture.close(); }
  });
}

for (const boundary of ["expired", "cancelled", "stale", "unknown_provider", "no_progress"]) {
  test(`research quota removal respects ${boundary} work`, async () => {
    const fixture = await blockerRecoveryFixture();
    try {
      await parkResearchLimit(fixture);
      if (boundary === "expired") fixture.advance(600_001);
      if (boundary === "cancelled") await fixture.recovery.cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
      if (boundary === "stale") fixture.base.staleSource();
      if (["unknown_provider", "no_progress"].includes(boundary)) await fixture.base.store.withLock("blocker.recovery", async () => {
        const ledger = await fixture.ledger();
        ledger.jobs[0].outcome_reason = boundary === "unknown_provider" ? "provider_outcome_unknown" : "technical_reconciliation_no_progress";
        await fixture.base.store.save("blocker.recovery", ledger);
      });
      await fixture.recreate().tick();
      assert.deepEqual(fixture.calls, ["sprint_leader"]);
      assert.equal(fixture.base.integrations, 0);
      if (boundary === "expired") {
        const ledger = await fixture.ledger();
        const resumed = await fixture.recovery.resumeStage({ projectId: "P", taskId: "TASK", executionId: "EXEC", jobId: ledger.jobs[0].id });
        assert.equal(resumed.technical_reconciliation.max_rounds, null);
        assert.equal(resumed.technical_reconciliation.round, 3);
        assert.equal(resumed.stage, "architecture_manager");
      }
    } finally { await fixture.close(); }
  });
}
