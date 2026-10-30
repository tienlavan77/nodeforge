/** Reproduces source context drift both before and during a resolved Coder
 * handoff. Production adapters must preserve decisions and checkpoints across
 * restart, without replaying SL/AM or reviving stopped/replaced executions. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { isBlockerSourceRetry } from "../../src/modules/supervisor/blocker/blocker-source-retry.js";

/** Builds a resolved SL/AM handoff at turn 82 using production recovery stores
 * so tests exercise dispatch fencing and checkpoint rollback, not just helpers. */
async function fixture(t) {
  const f = await blockerRecoveryFixture(); t.after(f.close);
  f.base.workspace.root_only = true;
  f.base.workspace.changeLedger.observe = f.base.workspace.changeLedger.snapshot;
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  const saved = await f.base.checkpoints.load("TASK");
  await f.base.checkpoints.save({ ...saved, last_completed_turn: 82, thread_id: "RETAINED" });
  await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
  assert.equal((await f.ledger()).jobs[0].status, "resume_pending");
  return f;
}

/** Represents the old guard's persisted preparation error, preserving its
 * accepted SL resolution and AM answer for recovery after an API restart. */
async function park(f) {
  const ledger = await f.ledger();
  const job = ledger.jobs[0];
  job.status = "cancelled";
  job.outcome_reason = "stale_execution_or_source";
  job.validation_feedback = [{ path: "/", reason: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", message: "Coder retry source changed during preparation." }];
  await f.base.store.save("blocker.recovery", ledger);
  return job;
}

test("shared-root source drift before and during preparation does not cancel accepted Coder handoff", async (t) => {
  const f = await fixture(t);
  f.base.staleSource();
  const sync = f.base.workspace.executionContexts.syncManifest;
  f.base.workspace.executionContexts.syncManifest = async (...args) => {
    const context = await sync(...args);
    return { ...context, source_revision: "PREPARED", manifest_sha: "PREPARED-MANIFEST", review_commit_sha: "NEW-COMMIT" };
  };
  await f.recovery.tick();
  assert.equal((await f.ledger()).jobs[0].status, "resumed");
  assert.equal(f.base.invocations, 2);
  assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 82);
  assert.equal((await f.base.checkpoints.load("TASK")).thread_id, "RETAINED");
});

test("restart recovers old cancelled preparation without duplicate jobs or agent decision replay", async (t) => {
  const f = await fixture(t);
  const prior = await park(f);
  f.base.staleSource();
  const restarted = f.recreate();
  await restarted.recover();
  assert.equal((await f.ledger()).jobs.length, 1);
  await restarted.tick();
  const job = (await f.ledger()).jobs[0];
  assert.equal(job.status, "resumed");
  assert.deepEqual(job.architecture_response, prior.architecture_response);
  assert.deepEqual(job.resolution, prior.resolution);
  assert.equal(job.history.filter((entry) => entry.event === "source_retry_preparation_refreshed").length, 1);
  assert.equal(f.base.invocations, 2);
  assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 82);
  await restarted.tick(); assert.equal(f.base.invocations, 2);
});

for (const mutation of ["stop", "replaceExecution", "revokePlan"]) {
  test(`source recovery does not revive ${mutation}`, async (t) => {
    const f = await fixture(t);
    await park(f); f.base.staleSource();
    if (mutation === "stop") await f.recovery.cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
    else f.base[mutation]();
    await f.recreate().tick();
    assert.equal(f.base.invocations, 1);
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 82);
  });
}

test("only a known resolved preparation failure is eligible for automatic source retry", () => {
  const job = { status: "cancelled", resolution: { action: "resolved" }, outcome_reason: "stale_execution_or_source",
    validation_feedback: [{ reason: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" }] };
  assert.equal(isBlockerSourceRetry(job), true);
  for (const patch of [{ outcome_reason: "owner_cancelled" }, { outcome_reason: "provider_outcome_unknown" },
    { validation_feedback: [] }, { resolution: { action: "owner_required" } }, { source_retry_policy: "agent-source-retry-v1" }]) {
    assert.equal(Boolean(isBlockerSourceRetry({ ...job, ...patch })), false);
  }
});
