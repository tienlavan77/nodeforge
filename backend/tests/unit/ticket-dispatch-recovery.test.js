// Proves crashed or competing approved RUN processes cannot redispatch captured inline handoffs after restart.
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDispatchStorage, openDispatchStorage, TICKET } from "../fixtures/ticket-dispatch-recovery-fixture.mjs";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";

// Starts an actual approved dispatch process and observes its first durable boundary or rejection.
function startWorker(root, stage) {
  const child = fork(new URL("../fixtures/ticket-dispatch-recovery-fixture.mjs", import.meta.url), ["worker", root, stage], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const message = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Worker exited before evidence: ${code}/${signal}: ${stderr}`)));
  });
  child.send({ start: true });
  return { child, message, exited };
}

// Reads durable fixture invocation/release evidence, distinguishing absence from storage errors.
async function evidence(root, name) {
  try { return await readFile(join(root, name), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

// Preserves child exit ordering before disposing test-only storage.
async function stopWorker(worker) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
  return worker.exited;
}

// Creates disposable approved authority and guarantees all processes stop before cleanup.
async function withDispatch(callback) {
  const root = await mkdtemp(join(tmpdir(), "ticket-dispatch-recovery-"));
  const workers = [];
  let storage;
  try {
    await initializeDispatchStorage(root);
    storage = await openDispatchStorage(root);
    await callback({ root, ...storage, start: (stage) => { const worker = startWorker(root, stage); workers.push(worker); return worker; } });
  } finally {
    await Promise.all(workers.map(stopWorker));
    await storage?.database.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const stage of ["execution-claimed", "queue-saved", "launch-claimed", "provider"]) {
  test(`SIGKILL after ${stage} retains original dispatch and never queue-replays it`, { timeout: 20000 }, async () => withDispatch(async (f) => {
    const worker = f.start(stage);
    assert.deepEqual(await worker.message, { boundary: stage });
    assert.equal((await stopWorker(worker)).signal, "SIGKILL");
    const original = f.store.get(TICKET.id);
    assert.equal(original.status, "running");
    const jobs = await f.queueStore.list("sender.handoff");
    assert.equal(jobs.length, stage === "execution-claimed" ? 0 : 1);
    if (jobs.length) {
      assert.equal(jobs[0].payload.execution_id, original.details.execution_id);
      assert.deepEqual(jobs[0].payload.dependency_expectations, []);
      const repaired = await f.queue.recover();
      assert.equal(repaired.length, 1);
      assert.equal(repaired[0].status, "dead_letter");
      assert.equal(repaired[0].reconciliation_required, true);
      assert.deepEqual(repaired[0].payload, jobs[0].payload);
      assert.deepEqual(await f.queue.recover(), []);
    }
    assert.equal(await f.queue.claim("restart-worker"), null);
    const restarted = f.start("provider");
    const rejection = await restarted.message;
    assert.ok(["STATUS_EXECUTION_ACTIVE", "TICKET_EXECUTION_RECONCILIATION_REQUIRED"].includes(rejection.error?.code), JSON.stringify(rejection));
    await restarted.exited;
    assert.equal(f.store.get(TICKET.id).details.execution_id, original.details.execution_id);
    assert.deepEqual(f.store.get(TICKET.id).details.launch_claim, original.details.launch_claim);
    assert.equal((await evidence(f.root, "launches.txt")).trim(), stage === "provider" ? original.details.execution_id : "");
    assert.equal(await evidence(f.root, "releases.txt"), "");
  }));
}

test("two independent shared RUN processes yield one provider invocation and preserve response-loss ownership", { timeout: 20000 }, async () => withDispatch(async (f) => {
  const workers = [f.start("provider"), f.start("provider")];
  const results = await Promise.all(workers.map((worker) => worker.message));
  assert.equal(results.filter((result) => result.boundary === "provider").length, 1);
  assert.ok(["STATUS_CONFLICT", "STATUS_EXECUTION_ACTIVE", "TICKET_EXECUTION_RECONCILIATION_REQUIRED"].includes(results.find((result) => result.error)?.error.code));
  await Promise.all(workers.map(stopWorker));
  const row = f.store.get(TICKET.id);
  assert.equal((await evidence(f.root, "launches.txt")).trim(), row.details.execution_id);
  assert.equal(f.store.getHistory(TICKET.id).filter((entry) => entry.reason === "execution_launch_claimed").length, 1);
  assert.equal(await f.queue.claim("response-loss-worker"), null);
  assert.equal((await f.queueStore.list("sender.handoff"))[0].reconciliation_required, true);
  assert.equal(await evidence(f.root, "releases.txt"), "");
}));

test("quarantine write failure keeps unknown provider ownership and restart repairs the retained job", { timeout: 20000 }, async () => withDispatch(async (f) => {
  const worker = f.start("quarantine-failure");
  const result = await worker.message;
  await worker.exited;
  assert.equal(result.error.code, "TICKET_EXECUTION_RECONCILIATION_REQUIRED");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.cause_code, "PROVIDER_UNKNOWN");
  assert.equal(result.error.reconciliation_error, "QUARANTINE_WRITE_FAILED");
  const row = f.store.get(TICKET.id);
  assert.equal(row.details.launch_claim.state, "launch_claimed");
  const [job] = await f.queueStore.list("sender.handoff");
  assert.equal(job.status, "queued");
  assert.equal(job.id, row.details.launch_claim.job_id);
  assert.equal(await evidence(f.root, "releases.txt"), "");
  assert.equal(await evidence(f.root, "outcomes.jsonl"), "");
  assert.equal(await f.queue.claim("repair-worker"), null);
  assert.equal((await f.queueStore.list("sender.handoff"))[0].status, "dead_letter");
  const retry = f.start("provider");
  assert.equal((await retry.message).error.code, "TICKET_EXECUTION_RECONCILIATION_REQUIRED");
  await retry.exited;
  assert.equal((await evidence(f.root, "launches.txt")).trim(), row.details.execution_id);
}));

test("orphan disposition write failure cannot return a lease and unrelated queues retain their contract", async () => {
  const item = { id: "JOB-A", request_id: "REQ-A", status: "queued", attempts: 0, payload: { dependency_expectations: [] } };
  const queue = createDurableQueue({ name: "sender.handoff", store: { list: async () => [item], save: async () => { throw new Error("Storage unavailable"); } } });
  await assert.rejects(queue.claim("worker"), /Storage unavailable/);
  await assert.rejects(queue.recover(), /Storage unavailable/);
  assert.equal(item.status, "queued");
  const normal = createDurableQueue({ name: "agent.request", store: { list: async () => [item], save: async () => {} } });
  assert.equal((await normal.claim("worker")).status, "leased");
});
