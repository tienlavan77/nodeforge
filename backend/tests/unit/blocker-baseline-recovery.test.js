/** Checks baseline handoff ownership independently of agent availability. Node
 * owns verification; SL receives exact results and Stop revokes live execution. */
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerBaselineRecovery } from "../../src/modules/supervisor/blocker/blocker-baseline-recovery.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

/** Models the durable queue reservation without touching production state. */
function fixture(recoverBaseline) {
  const job = { id: "JOB", stage: "sprint_leader", status: "invoking", invocation_id: "INVOCATION",
    request: { project_id: "P", task_id: "T", payload: { execution_id: "EXEC" } } };
  const ledger = { project_id: "P", task_id: "T", execution_id: "EXEC", jobs: [structuredClone(job)], cancelled: false };
  let authority = true;
  const logs = [];
  const prepare = createBlockerBaselineRecovery({ store: { list: async () => [ledger] },
    inspect: async () => authority ? { workspace: { testService: { recoverBaseline } } } : null,
    logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  return { job, ledger, prepare, logs, revoke: () => { authority = false; } };
}

test("Node executes baseline without a Coder claim and returns its receipt to the coordinating role", async () => {
  let calls = 0;
  const f = fixture(async ({ executionId, signal, assertActive }) => {
    calls++; await assertActive(); assert.equal(executionId, "EXEC"); assert.equal(signal.aborted, false);
    return { status: "passed", artifact_id: "ARTIFACT-BASELINE" };
  });
  assert.equal((await f.prepare(f.job)).artifact_id, "ARTIFACT-BASELINE");
  f.job.stage = f.ledger.jobs[0].stage = "architecture_manager";
  assert.equal((await f.prepare(f.job)).status, "passed");
  assert.equal(await f.prepare({ ...f.job, stage: "reviewer" }), null);
  assert.equal(await f.prepare({ ...f.job, status: "cancelled" }), null);
  assert.equal(calls, 2);
});

test("missing environment is returned as a structured diagnostic instead of another opaque recovery stop", async () => {
  const f = fixture(async () => { throw Object.assign(Error("Recorded manifest missing"), { code: "ENOENT" }); });
  const result = await f.prepare(f.job);
  assert.equal(result.status, "unavailable"); assert.equal(result.error.code, "ENOENT");
  assert.equal(f.logs.length, 1);
});

test("Stop, invocation replacement and execution replacement invalidate the command boundary", async () => {
  for (const change of [f => { f.ledger.cancelled = true; }, f => { f.ledger.jobs[0].invocation_id = "OTHER"; },
    f => { f.ledger.execution_id = "OTHER"; }, f => f.revoke()]) {
    let f;
    f = fixture(async ({ assertActive }) => { change(f); await assertActive(); return { status: "passed" }; });
    await assert.rejects(f.prepare(f.job), { code: "VERIFY_RECOVERY_CANCELLED" });
  }
});

test("Stop aborts a live baseline command instead of waiting for a long test timeout", async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); started();
  }));
  const running = f.prepare(f.job);
  await ready; f.ledger.cancelled = true;
  const keepAlive = setTimeout(() => {}, 3000);
  try { await assert.rejects(running, { code: "VERIFY_RECOVERY_CANCELLED" }); }
  finally { clearTimeout(keepAlive); }
});

test("production recovery prepares Node evidence before SL, renews its response deadline and resumes the saved Coder turn", async () => {
  const order = [];
  const f = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    order.push(job.stage);
    assert.equal(job.ticket_progress.verification.baseline_recovery.status, "passed");
    return resolution;
  } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.base.checkpoints.save({ ...checkpoint, last_completed_turn: 43, thread_id: "RETAINED" });
    f.base.workspace.testService.recoverBaseline = async ({ executionId, assertActive }) => {
      order.push("node_baseline"); assert.equal(executionId, "EXEC"); await assertActive();
      f.advance(700_000);
      return { status: "passed", artifact_id: "ARTIFACT-BASELINE", job_id: "VERIFY-BASELINE" };
    };
    await f.recovery.tick();
    assert.deepEqual(order, ["node_baseline", "sprint_leader"]);
    assert.equal((await f.ledger()).jobs.at(-1).status, "resume_pending");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "resumed");
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 43);
    assert.deepEqual(f.calls, ["sprint_leader"]);
  } finally { await f.close(); }
});
