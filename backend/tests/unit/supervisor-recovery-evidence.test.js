// Verifies recovery never invents a verification pass or applies a cached verdict to a replacement execution.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";
import { createReviewRequestHandler } from "../../src/modules/supervisor/review-request-handler.js";
import { assertCachedReviewResult, reviewRequestBasis } from "../../src/modules/supervisor/recovery-evidence.js";

const PLAN = { project_id: "PROJECT-A", sprint_id: "SPRINT-A", plan_id: "PLAN-A", plan_revision: 1, plan_path: "plans/a.json", plan_sha256: "a".repeat(64), version: 1 };
const STATE = { task_id: "TICKET-A", supervisor_id: "SUP-A", state: "REVIEWING", pending_request: { correlation_id: "CORR-A", attempt: 2 } };
const JOB = { id: "JOB-A", task_id: "TICKET-A", supervisor_id: "SUP-A", request_id: "REQ-A", correlation_id: "CORR-A", attempt: 2, status: "completed", payload: { changed_paths: ["a.js"] } };

test("production restart never infers verification PASS from queued, failed, or unbound jobs", async (t) => {
  for (const [name, changes] of [
    ["queued", { status: "queued" }],
    ["failed", { verification_result: { basis: reviewRequestBasis(JOB), payload: { status: "failed" } } }],
    ["missing result", {}],
    ["unbound result", { verification_result: { payload: { status: "passed" } } }],
    ["wrong supervisor", { supervisor_id: "SUP-OLD" }],
    ["wrong attempt", { attempt: 1 }],
    ["wrong correlation", { correlation_id: "CORR-OLD" }]
  ]) await t.test(name, async () => withRuntime(async (runtime, logs) => {
    await runtime.stateStore.save(STATE);
    await runtime.queueStore.save("verification.request", { ...JOB, ...changes });
    await runtime.recover();
    assert.equal((await runtime.stateStore.get("SUP-A")).state, "REVIEWING");
    assert.ok(logs.some((entry) => entry.error_code === "EXECUTION_RECONCILIATION_CONFLICT"));
    assert.equal((await runtime.queueStore.list("verification.request")).length, 1);
  }));
});

test("production restart applies only one matching persisted successful result and does not choose the latest task job", async () => withRuntime(async (runtime) => {
  await runtime.stateStore.save(STATE);
  await runtime.queueStore.save("verification.request", { ...JOB, verification_result: { basis: reviewRequestBasis(JOB), payload: { status: "passed", changed_paths: ["a.js"] } } });
  await runtime.queueStore.save("verification.request", { ...JOB, id: "JOB-OLD", supervisor_id: "SUP-OLD", attempt: 1 });
  await runtime.recover();
  assert.equal((await runtime.stateStore.get("SUP-A")).state, "COMPLETED");
  assert.equal((await runtime.queueStore.list("agent.request")).length, 0);
}));

test("ambiguous completed verification jobs require reconciliation without launching anything", async () => withRuntime(async (runtime) => {
  await runtime.stateStore.save(STATE);
  for (const id of ["JOB-A", "JOB-B"]) {
    const job = { ...JOB, id };
    await runtime.queueStore.save("verification.request", { ...job, verification_result: { basis: reviewRequestBasis(job), payload: { status: "passed" } } });
  }
  await runtime.recover();
  assert.equal((await runtime.stateStore.get("SUP-A")).state, "REVIEWING");
}));

test("production verification persists its actual result before fanout and queue acknowledgement", async () => withRuntime(async (runtime) => {
  const job = await runtime.queues["verification.request"].enqueue({ ...JOB, status: undefined });
  let delivered = 0;
  runtime.eventBus.subscribe("*", async (event) => {
    if (event.type !== "verification.passed") return;
    delivered += 1;
    const saved = (await runtime.queueStore.list("verification.request")).find((entry) => entry.id === job.id);
    assert.equal(saved.status, "leased");
    assert.equal(saved.verification_result.payload.status, "passed");
    assert.deepEqual(saved.verification_result.basis, reviewRequestBasis(job));
  });
  runtime.verificationWorkerLoop.start();
  for (let poll = 0; poll < 100; poll += 1) {
    const current = (await runtime.queueStore.list("verification.request")).find((entry) => entry.id === job.id);
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const saved = (await runtime.queueStore.list("verification.request")).find((entry) => entry.id === job.id);
  assert.equal(saved.status, "completed"); assert.equal(delivered, 1);
}));

test("Registry-owned recovery rejects a completed verdict belonging to a replacement execution", async () => {
  const current = { project_id: "PROJECT-A", details: { execution_id: "EXEC-NEW", execution_basis: PLAN } };
  await withRuntime(async (runtime, logs) => {
    await runtime.stateStore.save(STATE);
    const job = guardedJob();
    await runtime.queueStore.save("agent.request", { ...job, operation: "review", review_result: { type: "review.approved", payload: approved(), basis: reviewRequestBasis(job) } });
    await runtime.recover();
    assert.equal((await runtime.stateStore.get("SUP-A")).state, "REVIEWING");
    assert.ok(logs.some((entry) => entry.error_code === "EXECUTION_RECONCILIATION_CONFLICT"));
  }, { ticketStatusStore: { get: () => current } });
});

test("recovery basis survives the actual file-store JSON boundary without undefined-field drift", () => {
  const basis = reviewRequestBasis(JOB);
  assert.deepEqual(basis, JSON.parse(JSON.stringify(basis)));
  const job = guardedJob();
  job.payload.sprint_basis = job.execution_basis;
  delete job.execution_basis;
  assert.deepEqual(reviewRequestBasis(job).execution_basis, PLAN);
});

test("cached verdict binds artifact, commit, request, attempt, and immutable execution basis", () => {
  const job = guardedJob();
  job.payload.verification = { artifact_id: "ARTIFACT-A", commit_sha: "a".repeat(40) };
  job.review_result = { type: "review.approved", payload: approved(), basis: reviewRequestBasis(job) };
  assert.doesNotThrow(() => assertCachedReviewResult(job));
  for (const change of [
    { attempt: 3 }, { request_id: "REQ-NEW" }, { execution_id: "EXEC-NEW" },
    { execution_basis: { ...PLAN, plan_revision: 2 } },
    { payload: { ...job.payload, verification: { artifact_id: "ARTIFACT-B", commit_sha: "b".repeat(40) } } }
  ]) assert.throws(() => assertCachedReviewResult({ ...job, ...change }), { code: "EXECUTION_RECONCILIATION_CONFLICT" });
  assert.throws(() => assertCachedReviewResult({ ...job, review_result: { type: "review.approved", payload: approved() } }), { code: "EXECUTION_RECONCILIATION_CONFLICT" });
});

test("cached evidence failure cannot write findings/checkpoints, publish, acknowledge, or invoke another Reviewer", async () => {
  const job = guardedJob();
  job.review_result = { type: "review.approved", payload: approved(), basis: reviewRequestBasis(job) };
  const sideEffects = [];
  const handler = handlerFixture(sideEffects, {
    validateReviewEvidence: async () => { throw Object.assign(new Error("Artifact changed"), { code: "REVIEW_EVIDENCE_MISMATCH" }); }
  });
  await assert.rejects(handler(job), { code: "REVIEW_EVIDENCE_MISMATCH" });
  assert.deepEqual(sideEffects, []);
});

test("replacement during findings-store resolution cannot mutate the new attempt's evidence", async () => {
  let current = { project_id: "PROJECT-A", details: { execution_id: "EXEC-A", execution_basis: PLAN } };
  const effects = [];
  const handler = handlerFixture(effects, {
    ticketStatusStore: { get: () => current },
    reviewWorker: { review: async () => approved() },
    resolveReviewFindings: async () => {
      current = { ...current, details: { ...current.details, execution_id: "EXEC-NEW" } };
      return { recordReview: async () => effects.push("findings") };
    }
  });
  await assert.rejects(handler(guardedJob()), { code: "EXECUTION_RECONCILIATION_CONFLICT" });
  assert.deepEqual(effects, []);
});

test("valid cached review continues without another provider request and retains its bound verdict", async () => {
  const job = guardedJob();
  job.review_result = { type: "review.approved", payload: approved(), basis: reviewRequestBasis(job) };
  const effects = [];
  let validated = 0;
  await handlerFixture(effects, { validateReviewEvidence: async () => { validated += 1; } })(job);
  assert.equal(validated, 1);
  assert.deepEqual(effects, ["save", "checkpoint", "publish", "ack"]);
});

// Builds the original immutable execution request for negative Reviewer and recovery witnesses.
function guardedJob() { return { ...structuredClone(JOB), project_id: "PROJECT-A", execution_id: "EXEC-A", execution_basis: { ...PLAN }, agent_id: "CODER-A" }; }

// Supplies an independent approved verdict without claiming production Reviewer acceptance.
function approved() { return { verdict: "approved", reviewer_id: "REVIEWER-A", findings: [], source_revision: "REV-A" }; }

// Records attempted review side effects so stale evidence cannot be mistaken for a successful retry.
function handlerFixture(effects, overrides = {}) {
  return createReviewRequestHandler({ reviewWorker: { review: async () => { effects.push("provider"); return approved(); } },
    queueStore: { save: async (_queue, job) => { effects.push("save"); assert.deepEqual(job.review_result.basis, reviewRequestBasis(job)); } },
    checkpointStore: { completeReview: async () => effects.push("checkpoint"), saveReview: async () => effects.push("failed-checkpoint") },
    eventBus: { publish: async () => effects.push("publish") }, queue: { ack: async () => effects.push("ack") },
    ticketStatusStore: { get: () => ({ project_id: "PROJECT-A", details: { execution_id: "EXEC-A", execution_basis: PLAN } }) }, ...overrides });
}

// Runs actual file-backed production recovery in a disposable workspace without RUN or live worker startup.
async function withRuntime(callback, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-recovery-evidence-"));
  const logs = [];
  const runtime = createProductionSupervisorRuntime({ fileService: createFileService({ projectRoot: root }), root: "runtime",
    projectRoot: root, autoStartWorkers: false, logger: { info() {}, debug() {} }, projectLogger: (entry) => logs.push(entry),
    gitService: { status: async () => "" }, ...overrides });
  try { await callback(runtime, logs); }
  finally { runtime.senderWorker.stop(); runtime.collectorWorkerLoop.stop(); runtime.verificationWorkerLoop.stop(); await rm(root, { recursive: true, force: true }); }
}
