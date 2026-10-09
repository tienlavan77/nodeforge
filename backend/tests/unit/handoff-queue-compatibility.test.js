// Verifies legacy handoff leasing stays compatible while expired captured inline jobs remain non-dispatchable evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";

// Binds compatibility assertions to the actual queue source before and after this test file runs.
async function assertQueueSource() {
  const bytes = await readFile(new URL("../../src/modules/supervisor/durable-queue.js", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "ab7b69fdb8f3e3a2065900fc56d459495d864391f52cfba41a30433c0998d951");
}
test.before(assertQueueSource);
test.after(assertQueueSource);

// Uses the real file queue and lock with a deterministic clock, avoiding timing-based lease tests.
async function withQueue(callback) {
  const root = await mkdtemp(join(tmpdir(), "handoff-compatibility-"));
  let now = 1000;
  const store = createFileQueueStore({ fileService: createFileService({ projectRoot: root }) });
  const queue = createDurableQueue({ name: "sender.handoff", store, clock: () => now, leaseMs: 10, maxAttempts: 2 });
  try { await callback({ store, queue, advance: () => { now += 20; } }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("uncaptured handoff keeps request deduplication, lease, retry, max-attempts and ack behavior", async () => withQueue(async ({ queue, store }) => {
  const command = { request_id: "REQ-LEGACY", task_id: "TASK-LEGACY", payload: { text: "Legacy dispatch" } };
  const job = await queue.enqueue(command);
  assert.equal((await queue.enqueue(command)).id, job.id);
  assert.equal((await queue.claim("worker")).attempts, 1);
  assert.equal((await queue.reject(job.id, "retry")).status, "queued");
  assert.equal((await queue.claim("worker")).attempts, 2);
  assert.equal((await queue.reject(job.id, "terminal")).status, "dead_letter");
  assert.equal((await store.list("sender.handoff"))[0].reconciliation_required, undefined);
  const next = await queue.enqueue({ ...command, request_id: "REQ-NEXT" });
  assert.equal((await queue.claim("worker")).id, next.id);
  assert.equal((await queue.ack(next.id)).status, "completed");
  assert.equal(await queue.claim("worker"), null);
}));

test("uncaptured expired lease recovers to queued, then dead-letter at max-attempts", async () => withQueue(async ({ queue, store, advance }) => {
  const job = await queue.enqueue({ request_id: "REQ-EXPIRED", payload: {} });
  await queue.claim("lost-worker");
  advance();
  const [recovered] = await queue.recover();
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.failure_reason, "lease_expired");
  assert.equal(recovered.reconciliation_required, undefined);
  assert.equal((await queue.claim("replacement-worker")).attempts, 2);
  advance();
  assert.equal((await queue.recover())[0].status, "dead_letter");
  assert.equal((await store.list("sender.handoff"))[0].failure_reason, "lease_expired");
  assert.equal(await queue.claim("third-worker"), null);
}));

test("uncaptured expired lease may be reclaimed directly without recover", async () => withQueue(async ({ queue, advance }) => {
  const job = await queue.enqueue({ request_id: "REQ-DIRECT", payload: {} });
  await queue.claim("lost-worker");
  advance();
  const claimed = await queue.claim("replacement-worker");
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.attempts, 2);
  assert.equal(claimed.worker_id, "replacement-worker");
}));

for (const action of ["claim", "recover"]) {
  test(`historical captured expired lease is quarantined by ${action}, preserving original identity`, async () => withQueue(async ({ queue, store }) => {
    const job = { id: "JOB-CAPTURED", request_id: "REQ-CAPTURED", task_id: "TICKET-A", status: "leased", attempts: 1, worker_id: "lost-worker", lease_until: new Date(900).toISOString(), payload: { execution_id: "RUN-A", dependency_expectations: [] } };
    await store.save("sender.handoff", job);
    if (action === "claim") assert.equal(await queue.claim("replacement-worker"), null);
    else assert.equal((await queue.recover())[0].status, "dead_letter");
    const [current] = await store.list("sender.handoff");
    assert.equal(current.id, job.id);
    assert.equal(current.attempts, job.attempts);
    assert.equal(current.worker_id, job.worker_id);
    assert.deepEqual(current.payload, job.payload);
    assert.equal(current.reconciliation_required, true);
    assert.equal(current.failure_reason, "inline_execution_reconciliation_required");
    assert.deepEqual(await queue.recover(), []);
    assert.equal(await queue.claim("another-worker"), null);
  }));
}

test("unexpired captured lease and completed inline acknowledgement are not treated as expired orphans", async () => withQueue(async ({ queue, store }) => {
  const active = { id: "JOB-ACTIVE", request_id: "REQ-ACTIVE", status: "leased", attempts: 1, lease_until: new Date(2000).toISOString(), payload: { dependency_expectations: [] } };
  await store.save("sender.handoff", active);
  assert.deepEqual(await queue.recover(), []);
  assert.equal(await queue.claim("worker"), null);
  assert.equal((await store.list("sender.handoff"))[0].status, "leased");
  await queue.ack(active.id);
  assert.deepEqual(await queue.recover(), []);
  assert.equal((await store.list("sender.handoff"))[0].status, "completed");
}));

test("captured orphan does not starve a following uncaptured handoff", async () => withQueue(async ({ queue, store }) => {
  const captured = await queue.enqueue({ request_id: "REQ-CAPTURED", payload: { dependency_expectations: [] } });
  const legacy = await queue.enqueue({ request_id: "REQ-LEGACY", payload: {} });
  assert.equal((await queue.claim("worker")).id, legacy.id);
  assert.equal((await store.list("sender.handoff")).find((job) => job.id === captured.id).status, "dead_letter");
}));
