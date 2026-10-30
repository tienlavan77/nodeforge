// Verifies explicit review reopening retains integrated source, history and execution authority.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createCompletedReviewResume, isCompletedReviewReopened } from "../../src/modules/supervisor/review/completed-review-resume.js";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";

// Models a retained completed review without running providers or modifying integrated Coder files.
async function fixture(verdict = "request_changes", dispatchError = null, severity = "major") {
  const f = automaticReviewFixture({ gate: "off" });
  const job = await f.prepare();
  const context = { ...await f.workspace.executionContexts.load(), state: "terminal" };
  f.workspace.executionContexts.load = async () => context;
  let row = { project_id: "PROJECT-1", status: "reviewing", version: 1,
    details: { review_reopen: { job_id: job.id, commit: job.payload.commit, artifact_id: f.artifact.artifact_id } } };
  let checkpoint = { status: "failed", review_attempt: 1 };
  let calls = 0;
  let repairs = 0;
  f.workspace.beginReviewRepair = async () => ({ receipt: "repair.json" });
  const store = { get: () => row, updateStatus: (_id, status, details, expected) => {
    assert.equal(expected.expectedVersion, row.version);
    row = { ...row, status, details, version: row.version + 1 };
    return row;
  } };
  const resume = createCompletedReviewResume({ queueStore: f.queueStore, ticketStatusStore: store,
    fileService: { createLock: async () => ({ release: async () => {} }) }, resolveTicketWorkspace: async () => f.workspace,
    resolveWorker: async () => ({ review: async () => { calls++; return { verdict, reviewer_id: "reviewer-1", findings: verdict === "approved" ? [] : [{ failure: "Missing coverage", severity }] }; } }),
    resumeRepair: async (input) => { if (dispatchError) throw dispatchError; repairs++; assert.equal(input.payload.resume_from.last_completed_turn, 67); assert.equal(input.payload.resume_from.blocker_recovery, null); return { status: "repair_started" }; },
    checkpoints: { load: async () => ({ status: "completed", last_completed_turn: 67, blocker_recovery: { status: "resolved" } }), save: async () => {}, loadReview: async () => checkpoint, saveReview: async (value) => { checkpoint = value; }, completeReview: async (_id, value) => { checkpoint = { ...value, status: "completed" }; } } });
  return { f, job, context, store, resume: () => resume({ projectId: "PROJECT-1", ticketId: "TICKET-1" }), calls: () => calls, repairs: () => repairs,
    checkpoint: () => checkpoint, block: () => { checkpoint.status = "in_progress"; } };
}

test("retained request_changes hands findings to Coder without replaying original completion", async () => {
  const f = await fixture();
  const result = await f.resume();
  assert.equal(result.status, "repair_started");
  assert.equal(f.store.get().status, "running");
  assert.equal(f.repairs(), 1);
  assert.equal(f.context.state, "terminal");
  assert.equal(f.checkpoint().verdict, "request_changes");
  assert.equal(f.f.integrations, 0);
  assert.equal(isCompletedReviewReopened(f.job, f.store), true);
});

// A reopened review retains the same repair authority regardless of how severe its implementation finding is.
test("reopened blocker finding resumes Coder from the retained checkpoint", async () => {
  const f = await fixture("request_changes", null, "blocker");
  assert.equal((await f.resume()).status, "repair_started");
  assert.equal(f.repairs(), 1);
  assert.equal(f.store.get().status, "running");
  assert.equal(f.checkpoint().findings[0].severity, "blocker");
});

test("only independent approval restores completed status", async () => {
  const f = await fixture("approved");
  assert.equal((await f.resume()).status, "completed");
  assert.equal(f.store.get().status, "done");
});

test("active or obsolete retained reviews cannot launch a provider", async () => {
  const f = await fixture();
  f.block();
  await assert.rejects(f.resume(), { code: "REVIEW_ATTEMPT_ACTIVE" });
  assert.equal(f.calls(), 0);
  f.store.get().details.review_reopen.commit = "different";
  await assert.rejects(f.resume(), { code: "REVIEW_REOPEN_CONFLICT" });
  assert.equal(f.calls(), 0);
});

test("Owner reopening uses CAS and retains execution plus terminal history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nf-review-reopen-"));
  const database = await createDatabaseService({ dataDir: dir });
  t.after(async () => { await database.close(); await rm(dir, { recursive: true, force: true }); });
  const store = createTicketStatusStore({ database, projectId: "PROJECT-1" });
  store.create("T"); store.updateStatus("T", "running"); store.updateStatus("T", "done");
  database.run("UPDATE ticket_status SET details_json=? WHERE ticket_id=?", [JSON.stringify({ execution_id: "RUN-1" }), "T"]);
  const binding = { job_id: "JOB-1", commit: "a".repeat(40), artifact_id: "A", owner_request: "reopen review", receipt: "receipt.json" };
  assert.throws(() => store.reopenReview("T", { expectedVersion: 1, executionId: "RUN-1", binding }), { code: "REVIEW_REOPEN_CONFLICT" });
  const row = store.reopenReview("T", { expectedVersion: 2, executionId: "RUN-1", binding });
  assert.equal(row.status, "reviewing"); assert.equal(row.details.execution_id, "RUN-1");
  store.updateStatus("T", "running", { reason: "repair_started" });
  store.updateStatus("T", "failed", { reason: "temporary_failure" });
  assert.deepEqual(store.get("T").details.review_reopen, binding);
  assert.deepEqual(store.getHistory("T").map((entry) => entry.to_status), ["running", "done", "reviewing", "running", "failed"]);
});

// A restart must not restore the old done event after Owner explicitly reopened review.
test("recovery suppresses the superseded completion intent", async () => {
  let completions = 0;
  let row = { status: "running", details: {} };
  const f = automaticReviewFixture({ gate: "off", ticketStatusStore: { get: () => row }, publicationFailure: (event) => { if (event.type === "task.completed") completions++; return false; } });
  await f.complete();
  const [job] = await f.queueStore.list("agent.request");
  row = { status: "reviewing", details: { review_reopen: { job_id: job.id } } };
  completions = 0;
  await f.restart().recover();
  await f.service.publishCompletion(job);
  assert.equal(completions, 0);
});

// An explicitly archived completion stays superseded when a legacy RUN allocated a replacement execution.
test("repair binding suppresses original completion without suppressing unrelated review jobs", () => {
  const job = { id: "J", payload: { execution_id: "OLD", verification: { commit_sha: "C", artifact_id: "A" } } };
  const row = { details: { execution_id: "NEW", review_reopen: { job_id: "J", repair_cycle_id: "R", commit: "C", artifact_id: "A" } } };
  assert.equal(isCompletedReviewReopened(job, { get: () => row }), true);
  row.details.review_reopen.artifact_id = "OTHER";
  assert.equal(isCompletedReviewReopened(job, { get: () => row }), false);
});

// A prelaunch failure must retain prepared Coder progress while exposing the original failure for Resume.
test("review repair submission failure parks ticket instead of leaving false running", async () => {
  const error = Object.assign(new Error("Dependency execution changed"), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  const f = await fixture("request_changes", error);
  await assert.rejects(f.resume(), (actual) => actual === error);
  const row = f.store.get();
  assert.equal(row.status, "failed");
  assert.equal(row.details.failure_code, error.code);
  assert.equal(row.details.reason, "review_repair_dispatch_failed");
  assert.ok(row.details.review_reopen.repair_cycle_id);
  assert.equal(f.checkpoint().verdict, "request_changes");
});
