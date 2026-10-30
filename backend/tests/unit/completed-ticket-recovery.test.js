// Verifies startup ignores durable completed work without losing interrupted publication, integration or explicit review reopening.
// Recovery side effects are counted directly so event deduplication cannot hide repeated queue writes or workspace reads.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createAutomaticTicketReview } from "../../src/modules/supervisor/review/automatic-ticket-review.js";
import { createBlockerRecovery } from "../../src/modules/supervisor/blocker/blocker-recovery.js";
import { isTicketRecoveryCompleted, isAutomaticReviewCompleted } from "../../src/modules/supervisor/ticket/ticket-recovery-state.js";

// Reconstructs production review recovery around retained evidence while observing every expensive or mutating operation.
function restartReview(fixture, row, { forbidWork = false } = {}) {
  const calls = { workspaces: 0, writes: 0, publications: 0 };
  const store = { get: () => structuredClone(row) };
  const queueStore = { list: fixture.queueStore.list, save: async (...args) => {
    assert.equal(forbidWork, false, "Completed history must not rewrite queues");
    calls.writes += 1; return fixture.queueStore.save(...args);
  } };
  const service = createAutomaticTicketReview({ operationalRetry: false, ticketStatusStore: store, queueStore,
    queue: { enqueue: async job => job, ack: async (id) => {
      const job = (await queueStore.list("agent.request")).find(entry => entry.id === id);
      await queueStore.save("agent.request", { ...job, status: "completed" });
    } }, fileService: fixture.fileService,
    resolveTicketWorkspace: async () => {
      assert.equal(forbidWork, false, "Completed history must not open a workspace");
      calls.workspaces += 1; return fixture.workspace;
    }, resolveWorker: async () => assert.fail("Recovery must not repeat the Reviewer"),
    eventBus: { publish: async event => {
      assert.equal(forbidWork, false, "Completed history must not replay events");
      calls.publications += 1; return fixture.eventBus.publish(event);
    } }, projectLogger: event => assert.fail(`Recovery failed: ${event.message}`) });
  return { service, calls };
}

test("repeated startup leaves acknowledged completed review evidence untouched without opening source", async () => {
  const fixture = automaticReviewFixture();
  await fixture.complete();
  const before = await fixture.queueStore.list("agent.request");
  const { service, calls } = restartReview(fixture, { project_id: "PROJECT-1", status: "done", details: {} }, { forbidWork: true });
  await service.recover(); await service.recover();
  assert.deepEqual(calls, { workspaces: 0, writes: 0, publications: 0 });
  assert.deepEqual(await fixture.queueStore.list("agent.request"), before);
  assert.equal(fixture.integrations, 1);
  assert.equal(fixture.calls, 1);
  assert.deepEqual(await service.findJob(before[0].job_key), before[0]);
});

test("acknowledged approval still recovers interrupted integration when the ticket is reviewing", async () => {
  const fixture = automaticReviewFixture();
  await fixture.service.process(await fixture.prepare());
  assert.equal((await fixture.queueStore.list("agent.request"))[0].status, "completed");
  const { service, calls } = restartReview(fixture, { project_id: "PROJECT-1", status: "reviewing", details: {} });
  await service.recover();
  assert.equal(fixture.integrations, 1);
  assert.equal(fixture.calls, 1);
  assert(calls.workspaces > 0);
  assert(fixture.events.some(event => event.type === "task.completed"));
});

test("completed Coder does not suppress deferred soft review or an unacknowledged result", async () => {
  const fixture = automaticReviewFixture({ gate: "off" });
  const job = await fixture.prepare();
  await fixture.service.recordCompletion(job, { completion: "coder_verified" });
  const context = await fixture.workspace.executionContexts.load();
  await fixture.workspace.executionContexts.update(job.task_id, context.version, { state: "terminal" });
  const { service } = restartReview(fixture, { project_id: "PROJECT-1", status: "done", details: {} });
  await service.recover();
  assert.equal((await fixture.queueStore.list("agent.request"))[0].status, "queued");
  assert.equal(fixture.calls, 0);
  await fixture.service.process((await fixture.queueStore.list("agent.request"))[0]);
  const result = (await fixture.queueStore.list("agent.request"))[0];
  await fixture.queueStore.save("agent.request", { ...result, status: "queued" });
  const restarted = restartReview(fixture, { project_id: "PROJECT-1", status: "done", details: {} });
  await restarted.service.recover();
  assert(restarted.calls.publications > 0);
  assert.equal((await fixture.queueStore.list("agent.request"))[0].status, "completed");
  assert.equal(fixture.calls, 1);
});

test("unfinished, reopened, foreign and launch-owned tickets are never classified as completed recovery", () => {
  const record = { task_id: "TASK", project_id: "PROJECT" };
  for (const row of [undefined, { status: "done" }, { project_id: "OTHER", status: "done" },
    ...["pending", "running", "reviewing", "failed", "needs_human_review", "cancelled"].map(status => ({ project_id: "PROJECT", status })),
    { project_id: "PROJECT", status: "done", details: { launch_claim: { request_id: "UNKNOWN" } } }]) {
    assert.equal(isTicketRecoveryCompleted(record, { get: () => row }), false);
  }
  assert.equal(isTicketRecoveryCompleted(record, { get: () => ({ project_id: "PROJECT", status: "done" }) }), true);
});

test("completed soft-review retry remains recoverable while a cancelled retry stays historical", () => {
  const store = { get: () => ({ project_id: "PROJECT", status: "done" }) };
  const job = { task_id: "TASK", project_id: "PROJECT", status: "completed", review_result: { payload: { error: { retryable: true } } } };
  assert.equal(isAutomaticReviewCompleted(job, store), false);
  assert.equal(isAutomaticReviewCompleted({ ...job, operational_retry: { status: "pending" } }, store), false);
  assert.equal(isAutomaticReviewCompleted({ ...job, operational_retry: { status: "cancelled" } }, store), true);
  assert.equal(isAutomaticReviewCompleted(job, store, { operationalRetry: false }), true);
  assert.equal(isAutomaticReviewCompleted({ ...job, review_result: undefined }, store), false);
});

test("blocker polling skips completed history before refreshing evidence and still services live tickets", async () => {
  const records = ["DONE", "LIVE"].map(taskId => ({ id: taskId, project_id: "PROJECT", task_id: taskId, execution_id: "EXEC", deadline_at: 100_000,
    jobs: [{ id: taskId, status: taskId === "DONE" ? "reconciliation_required" : "notification_pending", stage: "sprint_leader", history: [],
      request: { task_id: taskId, project_id: "PROJECT" } }] }));
  const before = structuredClone(records[0]);
  const store = { withLock: async (_name, run) => run(), list: async () => structuredClone(records),
    save: async (_name, ledger) => { records[records.findIndex(entry => entry.id === ledger.id)] = structuredClone(ledger); } };
  const statusStore = { get: taskId => ({ project_id: "PROJECT", status: taskId === "DONE" ? "done" : "needs_human_review" }) };
  const notifications = [], refreshed = [];
  const recovery = createBlockerRecovery({ store, clock: () => 1000, logger: { error: message => assert.fail(message) },
    isComplete: ledger => isTicketRecoveryCompleted(ledger, statusStore),
    validate: async job => { assert.equal(job.id, "LIVE"); return true; },
    refreshWaiting: async job => { refreshed.push(job.id); assert.equal(job.id, "LIVE"); return false; },
    investigate: async () => assert.fail("No historical agent invocation"), checkDisposition: async () => {},
    resume: async () => assert.fail("No historical Coder resume"), notify: async job => notifications.push(job.id) });
  await recovery.tick(); await recovery.tick();
  assert.deepEqual(records[0], before);
  assert.deepEqual(notifications, ["LIVE"]);
  assert.deepEqual(refreshed, ["LIVE"]);
  records[0].jobs[0].status = "pending";
  assert.equal(await recovery.hasPending({ projectId: "PROJECT", taskId: "DONE", executionId: "EXEC" }), false);
});

test("production blocker recovery checks durable completion before loading old checkpoints or source", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const before = await fixture.ledger();
    const current = fixture.base.statusStore.get("TASK");
    const recovery = fixture.recreate({ ticketStatusStore: {
      get: () => ({ ...current, status: "done", details: { ...current.details, launch_claim: null } }),
      listByStatus: () => []
    }, resolveTicketWorkspace: async () => assert.fail("Done ticket cannot reopen source"),
    checkpoints: { load: async () => assert.fail("Done ticket cannot reload recovery checkpoints") } });
    await recovery.recover(); await recovery.tick(); await recovery.tick();
    assert.deepEqual(await fixture.ledger(), before);
    assert.deepEqual(fixture.calls, []);
    assert.equal(await recovery.hasPending({ projectId: before.project_id, taskId: before.task_id, executionId: before.execution_id }), false);
  } finally { await fixture.close(); }
});
