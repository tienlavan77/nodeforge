// Verifies independent ticket dispatch continues during SDK work while durable reservations, cancellation and result fencing remain intact.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createBlockerRecovery } from "../../src/modules/supervisor/blocker-recovery.js";

// Holds a provider result under test control without preventing a second ticket from reaching dispatch.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Waits for detached persistence to settle with a finite test deadline and no provider timing assumptions.
async function waitFor(read, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, "Detached recovery work did not reach the expected durable state");
    await delay(10);
  }
}

// Creates two independent executions in real locked file storage; AM is held while the resolved Coder can complete.
async function fixture({ busy = false, holdCoder = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "forge-recovery-concurrency-"));
  const store = createFileQueueStore({ fileService: createFileService({ projectRoot: root }) });
  const entered = deferred(), finish = deferred(), errors = [], calls = [], resumed = [];
  const coderEntered = deferred(), coderFinish = deferred();
  let now = 1000;
  const ledger = (id) => store.withLock("blocker.recovery", async () => structuredClone((await store.list("blocker.recovery")).find((item) => item.id === id)));
  for (const [id, stage, status] of [["AM", "architecture_manager", "pending"], ["CODER", "sprint_leader", "resume_pending"]]) {
    const request = { task_id: id, project_id: "P", payload: { execution_id: `E-${id}` }, execution_context: { source_revision: `R-${id}` } };
    await store.withLock("blocker.recovery", () => store.save("blocker.recovery", { id, project_id: "P", task_id: id,
      execution_id: `E-${id}`, deadline_at: now + 600_000, calls: 0, resumes: 0,
      jobs: [{ id: `JOB-${id}`, stage, status, history: [], request, ...(id === "CODER" ? { resolution: { action: "resolved" } } : {}) }] }));
  }
  const options = { store, clock: () => now, logger: { error: (...args) => errors.push(args) },
    validate: async () => true, checkDisposition: async (value) => value, notify: async () => {},
    investigate: async (job) => {
      calls.push(job.request.task_id); entered.resolve();
      if (busy) throw Object.assign(new Error("AM is occupied"), { not_started: true });
      await finish.promise;
      return { action: "resolved", summary: "AM answered its ticket" };
    },
    resume: async (job) => {
      if (holdCoder && job.request.task_id === "CODER") { coderEntered.resolve(); await coderFinish.promise; }
      resumed.push(job.request.task_id);
    } };
  const recovery = createBlockerRecovery(options);
  return { store, recovery, entered, finish, coderEntered, coderFinish, errors, calls, resumed, ledger,
    createWorker: () => createBlockerRecovery(options),
    advance: (ms) => { now += ms; },
    close: async () => { recovery.stop(); finish.resolve(); coderFinish.resolve(); await delay(30); await rm(root, { recursive: true, force: true }); } };
}

test("background dispatch returns before AM finishes and delivers another ticket to Coder", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.recovery.tick({ background: true })).job_id, "JOB-AM");
    await f.entered.promise;
    assert.equal((await f.recovery.tick({ background: true })).job_id, "JOB-CODER");
    await waitFor(() => f.ledger("CODER"), (value) => value.jobs[0].status === "resumed");
    assert.deepEqual(f.resumed, ["CODER"]);
    assert.equal((await f.ledger("AM")).jobs[0].status, "invoking");
    f.advance(700_000);
    await Promise.all(Array.from({ length: 5 }, () => f.recovery.tick({ background: true })));
    assert.deepEqual(f.calls, ["AM"]);
    assert.equal((await f.ledger("AM")).jobs[0].status, "invoking");
    assert.deepEqual(f.errors, []);
    f.finish.resolve();
    const am = await waitFor(() => f.ledger("AM"), (value) => value.jobs[0].status === "pending");
    assert.equal(am.jobs[0].stage, "sprint_leader");
    assert.equal(am.jobs[0].architecture_response.disposition.action, "resolved");
  } finally { await f.close(); }
});

test("production polling dispatches another ticket while its first agent is still running", async () => {
  const f = await fixture();
  try {
    await f.recovery.start();
    await f.recovery.start();
    await f.entered.promise;
    await waitFor(() => f.ledger("CODER"), (value) => value.jobs[0].status === "resumed");
    assert.deepEqual(f.calls, ["AM"]);
    assert.deepEqual(f.resumed, ["CODER"]);
    assert.equal((await f.ledger("AM")).jobs[0].status, "invoking");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Stop fences the returning AM result without delaying another ticket", async () => {
  const f = await fixture();
  try {
    await f.recovery.tick({ background: true }); await f.entered.promise;
    await f.recovery.cancel({ projectId: "P", taskId: "AM", executionId: "E-AM" });
    await f.recovery.tick({ background: true });
    await waitFor(() => f.ledger("CODER"), (value) => value.jobs[0].status === "resumed");
    f.finish.resolve(); await delay(30);
    const am = await f.ledger("AM");
    assert.equal(am.cancelled, true);
    assert.equal(am.jobs[0].status, "cancelled");
    assert.equal(am.jobs[0].resolution, undefined);
    assert.deepEqual(f.resumed, ["CODER"]);
  } finally { await f.close(); }
});

test("an occupied role defers its own retry instead of starving an available Coder", async () => {
  const f = await fixture({ busy: true });
  try {
    await f.recovery.tick();
    assert.equal((await f.ledger("AM")).calls, 0);
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["AM"]);
    assert.deepEqual(f.resumed, ["CODER"]);
    assert.equal((await f.ledger("AM")).jobs[0].role_retry_at, 31_000);
    f.advance(30_000); await f.recovery.tick();
    assert.deepEqual(f.calls, ["AM", "AM"]);
  } finally { await f.close(); }
});

test("a long Coder execution also leaves AM-to-SL result coordination free to continue", async () => {
  const f = await fixture({ holdCoder: true });
  try {
    await f.recovery.tick({ background: true }); await f.entered.promise;
    await f.recovery.tick({ background: true }); await f.coderEntered.promise;
    assert.equal((await f.ledger("CODER")).jobs[0].status, "dispatching");
    f.finish.resolve();
    await waitFor(() => f.ledger("AM"), (value) => value.jobs[0].status === "pending");
    await f.recovery.tick();
    assert.equal((await f.ledger("AM")).jobs[0].status, "resume_pending");
    await f.recovery.tick();
    assert.deepEqual(f.resumed, ["AM"]);
    assert.equal((await f.ledger("CODER")).jobs[0].status, "dispatching");
    f.coderFinish.resolve();
    await waitFor(() => f.ledger("CODER"), (value) => value.jobs[0].status === "resumed");
    assert.deepEqual(f.resumed, ["AM", "CODER"]);
  } finally { await f.close(); }
});

test("a second worker cannot redispatch the reserved AM while serving another ticket", async () => {
  const f = await fixture();
  const second = f.createWorker();
  try {
    await f.recovery.tick({ background: true }); await f.entered.promise;
    await second.tick({ background: true });
    await waitFor(() => f.ledger("CODER"), (value) => value.jobs[0].status === "resumed");
    assert.deepEqual(f.calls, ["AM"]);
    assert.deepEqual(f.resumed, ["CODER"]);
    assert.equal((await f.ledger("AM")).calls, 1);
    assert.equal((await f.ledger("CODER")).resumes, 1);
  } finally { second.stop(); await f.close(); }
});
