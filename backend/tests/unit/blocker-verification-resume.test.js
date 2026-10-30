// Verifies terminal Node checks return parked coordination to SL without restarting Coder or bypassing external evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlockerVerificationResume } from "../../src/modules/supervisor/blocker/blocker-verification-resume.js";
import { createBlockerRecovery } from "../../src/modules/supervisor/blocker/blocker-recovery.js";

// Persists one source-bound verification job and recovery ledger in disposable runtime storage.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-verification-resume-"));
  let now = 1000, allowed = true, invocations = 0, resumes = 0;
  const context = { task_id: "TASK", project_id: "P", source_revision: "SOURCE", review_commit_sha: "COMMIT", version: 1 };
  const workspace = { projectRoot: root, executionContexts: { load: async () => context } };
  const previous = { job_id: "VERIFY-A", status: "running" };
  const job = { id: "JOB", stage: "sprint_leader", status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence",
    request: { task_id: "TASK", project_id: "P", execution_context: { ...context } }, history: [],
    ticket_progress: { verification: { job: previous } }, resolution: { reconciliation: { waiting_for: [
      { owner: "external", operation: "inspect", question: "Supply terminal result for VERIFY-A." }
    ] } } };
  let ledger = { id: "LEDGER", task_id: "TASK", project_id: "P", execution_id: "EXEC", deadline_at: now + 10000, calls: 0, resumes: 0, jobs: [job] };
  const store = { list: async () => [ledger], save: async (_name, value) => { ledger = value; }, withLock: async (_name, fn) => fn() };
  const inspect = async (input) => allowed && input.request.execution_context.review_commit_sha === context.review_commit_sha ? { workspace } : null;
  const logs = [];
  const options = { inspect, clock: () => now, projectLogger: (event) => logs.push(event) };
  const refresh = createBlockerVerificationResume(options);
  const engine = createBlockerRecovery({ store, clock: () => now, refreshWaiting: refresh, validate: async () => allowed,
    investigate: async () => { invocations++; return { action: "resolved" }; }, checkDisposition: async (value) => value,
    resume: async () => { resumes++; }, notify: async () => {} });
  const directory = join(root, ".forge/runtime/ticket-verification/TASK/jobs"); await mkdir(directory, { recursive: true });
  // Updates the owned asynchronous check without modifying ticket approval or source.
  async function save(status, patch = {}) {
    const value = { job_id: "VERIFY-A", task_id: "TASK", source_revision: "SOURCE", commit_sha: "COMMIT", status, attempt: 1, ...patch };
    await writeFile(join(directory, `${value.job_id}.json`), JSON.stringify(value));
  }
  await save("running");
  return { job, context, refresh, engine, save, logs, options, advance: () => { now += 30000; }, revoke: () => { allowed = false; },
    counts: () => ({ invocations, resumes }), ledger: () => ledger, close: () => rm(root, { recursive: true, force: true }) };
}

test("terminal verification wakes SL once, survives worker restart and leaves normal Coder dispatch to validated recovery", async () => {
  const f = await fixture();
  try {
    await f.engine.tick(); assert.deepEqual(f.counts(), { invocations: 0, resumes: 0 });
    await f.save("passed");
    await f.engine.tick(); assert.equal(f.counts().invocations, 0, "Polls are spaced by thirty seconds");
    f.advance(); await f.engine.tick();
    assert.equal(f.counts().invocations, 1); assert.equal(f.counts().resumes, 0);
    assert.equal(f.job.status, "resume_pending"); assert.equal(f.job.stage, "sprint_leader");
    assert(f.job.history.some((entry) => entry.event === "verification_wait_completed"));
    assert.equal(f.logs[0].payload.verification_status, "passed");
    f.job.status = "reconciliation_required"; f.job.outcome_reason = "technical_reconciliation_waiting_for_evidence";
    f.job.resolution = { reconciliation: { waiting_for: ["Terminal result for VERIFY-A"] } };
    assert.equal(await createBlockerVerificationResume(f.options)(f.job), false, "Restart must retain terminal evidence deduplication");
  } finally { await f.close(); }
});

test("failed checks also wake SL while cancelled executions, stale source and mixed external prerequisites stay parked", async () => {
  const f = await fixture();
  try {
    await f.save("failed"); assert.equal(await f.refresh(f.job), true);
    assert.equal(f.logs[0].payload.verification_status, "failed");
    delete f.job.verification_wait_digest;
    f.advance(); f.job.resolution.reconciliation.waiting_for.push("Owner must supply deployment approval");
    assert.equal(await f.refresh(f.job), false);
    f.job.resolution.reconciliation.waiting_for.pop(); f.revoke();
    assert.equal(await f.refresh(f.job), false);
    f.ledger().cancelled = true; await f.engine.tick(); assert.equal(f.counts().invocations, 0);
  } finally { await f.close(); }
});

test("other source jobs and previously supplied terminal evidence cannot wake recovery", async () => {
  const f = await fixture();
  try {
    await f.save("passed", { commit_sha: "OTHER" }); assert.equal(await f.refresh(f.job), false);
    f.advance(); await f.save("passed"); f.job.ticket_progress.verification.job = { job_id: "VERIFY-A", status: "passed" };
    assert.equal(await f.refresh(f.job), false);
    f.advance(); await f.save("passed", { job_id: "VERIFY-B", attempt: 2 });
    assert.equal(await f.refresh(f.job), true, "A newer same-source terminal attempt supplies new evidence to SL");
  } finally { await f.close(); }
});
