/** Verifies polling storage failures retain actionable diagnostics and cannot
 * starve other tickets, erase retained checkpoints or spin on every timer tick. */
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerRecovery } from "../../src/modules/supervisor/blocker/blocker-recovery.js";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";

test("a failing parked job retains its state while the same poll handles another ticket and retries after 30s", async () => {
  let now = 1000, attempts = 0;
  const bad = { id: "BAD", stage: "sprint_leader", status: "reconciliation_required", history: [],
    request: { project_id: "P", task_id: "TASK-BAD" } };
  const good = { id: "GOOD", stage: "sprint_leader", status: "notification_pending", history: [],
    request: { project_id: "P", task_id: "TASK-GOOD" } };
  let ledgers = [{ id: "LEDGER", deadline_at: 100_000, jobs: [bad, good] }];
  const original = structuredClone(bad), events = [], notified = [], output = [];
  const logger = createRuntimeLogger({ logEvent: (entry) => events.push(entry), output: { write: (line) => output.push(line) } });
  const recovery = createBlockerRecovery({ clock: () => now, logger,
    store: { withLock: async (_name, run) => run(), list: async () => structuredClone(ledgers),
      save: async (_name, value) => { ledgers = [structuredClone(value)]; } },
    validate: async () => true, investigate: async () => assert.fail("No provider may run for failed refresh"),
    checkDisposition: async () => {}, resume: async () => assert.fail("No checkpoint reset"), notify: async (job) => notified.push(job.id),
    refreshWaiting: async (job) => {
      if (job.id !== "BAD") return false;
      attempts += 1;
      throw Object.assign(new Error("File exceeds the read limit: receipt.json."), { code: "FILE_TOO_LARGE", path: "receipt.json" });
    } });
  await recovery.tick();
  assert.deepEqual(notified, ["GOOD"]);
  assert.deepEqual(ledgers[0].jobs[0], original);
  assert.equal(events[0].task_id, "TASK-BAD");
  assert.equal(events[0].project_id, "P");
  assert.equal(events[0].error_code, "FILE_TOO_LARGE");
  assert.match(events[0].payload.error, /receipt.json/);
  assert.match(events[0].payload.stack, /FILE|File/);
  assert.match(output[0], /FILE_TOO_LARGE.*retry in 30s/);
  await recovery.tick();
  now += 29_999; await recovery.tick();
  assert.equal(attempts, 1);
  now += 1; await recovery.tick();
  assert.equal(attempts, 2);
  assert.equal(events.length, 2);
});

test("top-level poll failures preserve Error message, code and stack in persisted logs", async () => {
  let resolveEvent;
  const received = new Promise((resolve) => { resolveEvent = resolve; });
  const logger = createRuntimeLogger({ logEvent: resolveEvent, output: { write() {} } });
  const recovery = createBlockerRecovery({ logger,
    store: { withLock: async () => { throw Object.assign(new Error("Queue cannot be read"), { code: "EIO" }); } },
    validate: async () => true, investigate: async () => {}, checkDisposition: async () => {}, resume: async () => {}, notify: async () => {} });
  try {
    await recovery.start();
    const event = await received;
    assert.equal(event.event_name, "supervisor.blocker_poll_failed");
    assert.equal(event.error_code, "EIO");
    assert.match(event.message, /Queue cannot be read/);
    assert.match(event.payload.stack, /Queue cannot be read/);
  } finally { recovery.stop(); }
});
