// Exercises completed finding checkpoints entering a new dependency repair, including interrupted prelaunch recovery.
// Real journals and the original finding preparation guard reproduce the conflict before any provider can run.
import assert from "node:assert/strict";
import test from "node:test";
import { dependencyRepairFixture, waitForDependency } from "../fixtures/dependency-repair-fixture.js";
import { prepareFindingReviewRepair } from "../../src/modules/supervisor/finding-review-repair-workspace.js";
import { createDependencyRepairCoordinator } from "../../src/modules/supervisor/coder/dependency-repair-coordinator.js";

const QUEUE = "ticket.dependency-repair";
const REVIEW_KEY = `sha256:${"d".repeat(64)}`;

// Seeds the completed finding identity that remains valid only inside the archived integrated cycle.
async function retainFindingCheckpoint(f) {
  const context = { ...f.context, source_repair_cycle_id: REVIEW_KEY.slice(7) };
  await f.files.atomicWrite({ path: f.contextPath, content: JSON.stringify(context), replace: true });
  await f.checkpoints.complete("UP", { review_repair_key: REVIEW_KEY, repair_implementation_required: true,
    review_findings: [{ id: "REV-CLOSED" }], contract_decisions: [{ path: "am-decision.json" }], execution_context: context });
}

// Reproduces an older runtime carrying its stale key past journal preparation into the real finding guard.
async function failedLegacyRepair(t) {
  let f, legacy = true;
  f = await dependencyRepairFixture(t, { dispatch: async () => {
    const coder = await f.checkpoints.load("UP");
    if (!legacy) {
      assert.equal(coder.review_repair_key, undefined);
      assert.equal(coder.last_completed_turn, 36);
      return { status: "accepted" };
    }
    legacy = false;
    await f.checkpoints.save({ ...coder, review_repair_key: REVIEW_KEY });
    return prepareFindingReviewRepair({ taskId: "UP", projectId: "P", fileService: f.files,
      executionContexts: f.contexts, reviewKey: REVIEW_KEY });
  } });
  await retainFindingCheckpoint(f);
  await f.request(); await f.coordinator.tick();
  const entry = await waitForDependency(f, (entry) => entry?.status === "failed");
  assert.equal(entry.error.code, "REVIEW_REPAIR_SOURCE_CONFLICT");
  await f.coordinator.refresh(f.job);
  f.job.status = "reconciliation_required";
  f.job.outcome_reason = "TICKET_EXECUTION_RECONCILIATION_REQUIRED";
  f.job.last_error = "Dependency expectations need reconciliation.";
  await f.store.save("blocker.recovery", { id: "LEDGER", task_id: "PARENT", project_id: "P", execution_id: "RUN-PARENT", jobs: [f.job] });
  return f;
}

test("a new dependency cycle retires old finding commands without losing SDK progress or AM decisions", async (t) => {
  const f = await dependencyRepairFixture(t);
  await retainFindingCheckpoint(f);
  await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  const coder = await f.checkpoints.load("UP");
  assert.equal(coder.review_repair_key, undefined);
  assert.equal(coder.repair_implementation_required, undefined);
  assert.equal(coder.review_findings, undefined);
  assert.equal(coder.session_id, "SDK-SESSION");
  assert.equal(coder.last_completed_turn, 36);
  assert.deepEqual(coder.contract_decisions, [{ path: "am-decision.json" }]);
});

test("an untouched legacy source conflict resumes the accepted repair automatically without consulting SL again", async (t) => {
  const f = await failedLegacyRepair(t);
  const parent = await f.checkpoints.load("PARENT");
  const context = await f.contexts.load("UP");
  await f.coordinator.tick();
  assert.equal((await f.store.list(QUEUE))[0].status, "queued");
  const job = (await f.store.list("blocker.recovery"))[0].jobs[0];
  assert.equal(job.status, "dependency_wait");
  assert.equal(job.dependency_result, undefined);
  assert.equal(job.history.at(-1).event, "dependency_checkpoint_recovered");
  await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  assert.equal(f.state.launches.length, 2);
  assert.deepEqual(await f.contexts.load("UP"), context);
  assert.deepEqual(await f.checkpoints.load("PARENT"), parent);
});

test("prelaunch checkpoint recovery respects Stop, source changes, new work and provider launch claims", async (t) => {
  for (const boundary of ["parent_stop", "target_stop", "source_changed", "agent_progress", "provider_claim", "different_error"]) {
    await t.test(boundary, async (t) => {
      const f = await failedLegacyRepair(t);
      if (boundary === "parent_stop") f.state.cancelled.add("PARENT");
      if (boundary === "target_stop") f.state.cancelled.add("UP");
      if (boundary === "source_changed") {
        const context = await f.contexts.load("UP");
        await f.contexts.update("UP", context.version, { source_revision: "changed" });
      }
      if (boundary === "agent_progress") await f.checkpoints.save({ ...await f.checkpoints.load("UP"), completed_tools: ["read_file"] });
      if (boundary === "provider_claim") {
        const current = f.statuses.get("UP");
        f.statuses.resumeReviewExecution("UP", { executionId: "RUN-UP", basis: f.basis, expectedVersion: current.version,
          dependencyExpectations: current.details.dependency_expectations, validate: () => {} });
        f.statuses.claimExecutionLaunch("UP", { executionId: "RUN-UP", basis: f.basis, requestId: "SDK", jobId: "SDK-JOB", supervisorId: "SUP-UP", agentId: "CODER", validate: () => {} });
      }
      if (boundary === "different_error") {
        const entry = (await f.store.list(QUEUE))[0];
        await f.store.save(QUEUE, { ...entry, error: { code: "PROVIDER_UNKNOWN" } });
      }
      const coder = await f.checkpoints.load("UP");
      await f.coordinator.tick();
      assert.equal((await f.store.list(QUEUE))[0].status, "failed");
      assert.deepEqual(await f.checkpoints.load("UP"), coder);
      assert.equal(f.state.launches.length, 1);
    });
  }
});

test("recovery survives interruption after the checkpoint write and before parent reattachment", async (t) => {
  const f = await failedLegacyRepair(t);
  const save = f.store.save;
  let interrupted = false;
  const store = { ...f.store, save: async (name, value) => {
    if (!interrupted && name === "blocker.recovery" && value.jobs[0].status === "dependency_wait") {
      interrupted = true; throw new Error("parent-save interrupted");
    }
    return save(name, value);
  } };
  const coordinator = createDependencyRepairCoordinator({ ...f.services, store, logger: { error: () => {} } });
  await coordinator.tick();
  assert.equal((await f.store.list(QUEUE))[0].status, "recovering");
  assert.equal((await f.checkpoints.load("UP")).review_repair_key, undefined);
  await coordinator.tick();
  assert.equal((await f.store.list(QUEUE))[0].status, "queued");
  await coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  assert.equal(f.state.launches.length, 2);
});
