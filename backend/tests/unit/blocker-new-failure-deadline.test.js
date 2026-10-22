// Keeps new ticket blockers actionable after long Coder work without extending duplicate failures or replaying providers.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerRecovery } from "../../src/modules/supervisor/blocker-recovery.js";

// Builds a durable recovery clock and ledger so deadline behavior can be verified without SDK delays.
function fixture() {
  let now = 1000;
  let ledgers = [];
  const calls = [];
  const store = {
    withLock: async (_name, callback) => callback(),
    list: async () => structuredClone(ledgers),
    save: async (_name, value) => {
      const index = ledgers.findIndex((entry) => entry.id === value.id);
      if (index < 0) ledgers.push(structuredClone(value));
      else ledgers[index] = structuredClone(value);
    }
  };
  const request = { project_id: "P", task_id: "T", payload: { execution_id: "E" }, execution_context: { source_revision: "R" } };
  const first = { request, reason_code: "ACCESS_REQUIRED", failure_at: "2026-10-21T09:00:00Z" };
  const second = { ...first, failure_at: "2026-10-21T11:55:11Z" };
  // Reconstructs the poller while preserving deadline and attempt records in its backing store.
  function create() {
    return createBlockerRecovery({ store, clock: () => now, deadlineMs: 1000,
      validate: async (job) => job.failure_at === second.failure_at,
      investigate: async (job) => { calls.push(job.id); return { action: "resolved", summary: "Continue Coder repair." }; },
      checkDisposition: async (value) => value, resume: async () => {}, notify: async () => {} });
  }
  return { create, first, second, calls, advance: (duration) => { now += duration; }, ledger: () => structuredClone(ledgers[0]),
    cancel: () => { ledgers[0].cancelled = true; } };
}

test("a distinct blocker after the previous deadline receives a new full window and calls SL", async () => {
  const f = fixture();
  await f.create().enqueue(f.first);
  assert.equal(f.ledger().deadline_at, 2000);
  f.advance(7200000);
  const worker = f.create();
  const newJob = await worker.enqueue(f.second);
  assert.equal(f.ledger().deadline_at, 7202000);
  assert.equal(f.ledger().jobs.length, 2);
  await f.create().tick();
  assert.deepEqual(f.calls, [newJob.id]);
  assert.equal(f.ledger().jobs[0].outcome_reason, "stale_execution_or_source");
  assert.equal(f.ledger().jobs[1].status, "resume_pending");
});

test("redelivery and restart cannot replenish the same failure's expired deadline", async () => {
  const f = fixture();
  await f.create().enqueue(f.second);
  f.advance(1001);
  await f.create().enqueue(f.second);
  assert.equal(f.ledger().deadline_at, 2000);
  assert.equal(f.ledger().jobs.length, 1);
  await f.create().tick();
  await f.create().tick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.ledger().jobs[0].outcome_reason, "triage_deadline_exhausted");
});

test("a new blocker cannot reset owner Stop or replenish a cancelled execution", async () => {
  const f = fixture();
  await f.create().enqueue(f.first);
  f.cancel(); f.advance(7200000);
  assert.equal(await f.create().enqueue(f.second), null);
  assert.equal(f.ledger().deadline_at, 2000);
  assert.equal(f.ledger().jobs.length, 1);
  await f.create().tick();
  assert.deepEqual(f.calls, []);
});
