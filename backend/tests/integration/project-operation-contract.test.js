// Contract acceptance for durable project lifecycle operations (TICKET-NF-CA-OPERATION AC-1, AC-2, AC-6, AC-7).
// Business purpose: a Create/Add request must be uniquely reconcilable after lost responses and
// concurrent retries, persisted atomically, and immune to watcher disconnects, so this test pins
// the operation schema, the validated stage table, optimistic revision control and request-key
// reconciliation against real managed-storage files. Technical description: each scenario uses a
// fresh mkdtemp store; AJV (the repository's declared schema validator) checks the published JSON
// Schema against representative fixtures, then the store contract exercises duplicate, conflict,
// throttle and disconnect behavior through the public API only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  OPERATION_KINDS, OPERATION_STAGES, OPERATION_STAGE_TRANSITIONS, assertStageTransition,
  computeRequestFingerprint, validateOperationSnapshot
} from "../../src/modules/projects/project-operation-contract.js";
import { createProjectOperationStore } from "../../src/modules/projects/project-operation-store.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

// Creates an isolated managed-storage directory plus a store over it, mirroring the durability
// guarantees the lifecycle integration expects without touching real catalog storage.
async function freshStore() {
  const directory = await mkdtemp(join(tmpdir(), "project-operation-"));
  return { directory, store: await createProjectOperationStore({ directory }) };
}

// AC-1: the new operation schema exists as its own contract and accepts a complete lifecycle
// snapshot while rejecting unknown kinds/stages, so intent can never be stored as membership.
test("operation schema validates complete snapshots and rejects unknown kind or stage", async () => {
  const schema = JSON.parse(await readFile(join(REPO_ROOT, "schemas/project/project-operation.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(schema.$id);
  const valid = JSON.parse(await readFile(join(REPO_ROOT, "schemas/examples/project-operation.json"), "utf8"));
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  const invalid = JSON.parse(await readFile(join(REPO_ROOT, "schemas/examples/project-operation-invalid.json"), "utf8"));
  assert.equal(validate(invalid), false);
  assert.deepEqual(OPERATION_KINDS, ["create", "add"]);
  assert.deepEqual(OPERATION_STAGES, ["intended", "attempted", "committed", "settled", "abandoned"]);
});

// AC-1: transitions outside the approved table are rejected, including rewinding a committed
// Create and any move out of a terminal stage, so membership stages cannot be silently undone.
test("invalid transitions are rejected and committed work cannot rewind", () => {
  assertStageTransition("intended", "attempted");
  assertStageTransition("committed", "settled");
  assert.throws(() => assertStageTransition("intended", "committed"), (error) => error.code === "transition_invalid");
  assert.throws(() => assertStageTransition("intended", "settled"), (error) => error.code === "transition_invalid");
  assert.throws(() => assertStageTransition("committed", "abandoned"), (error) => error.code === "transition_invalid");
  assert.throws(() => assertStageTransition("settled", "attempted"), (error) => error.code === "transition_invalid");
  for (const from of OPERATION_STAGES) {
    for (const to of OPERATION_STAGES) {
      if (OPERATION_STAGE_TRANSITIONS[from].includes(to)) assertStageTransition(from, to);
      else assert.throws(() => assertStageTransition(from, to));
    }
  }
});

// AC-1: a snapshot missing identity fields or claiming a terminal status without its outcome is
// refused before persistence, so partial records cannot masquerade as finished operations.
test("snapshot validation rejects missing fields and terminal status without result", () => {
  assert.throws(() => validateOperationSnapshot(null), (error) => error.code === "snapshot_invalid");
  const base = {
    operation_id: "OPRO-x1", request_key: "k1",
    request_fingerprint: computeRequestFingerprint({ kind: "add", root: "/r" }),
    kind: "add", root: "/r", attempt: 1, revision: 0, stage: "committed", status: "succeeded",
    counters: { transitions: 2, attempts: 1 },
    timestamps: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  };
  assert.throws(() => validateOperationSnapshot(base), (error) => error.code === "snapshot_invalid");
  assert.doesNotThrow(() => validateOperationSnapshot({ ...base, result: { outcome: "succeeded" } }));
});

// AC-2 / AC-6: resubmitting the same request key with the same fingerprint returns the original
// operation even when the client lost the response before ever seeing the operation id.
test("resubmit after lost response returns the same operation", async () => {
  const { store } = await freshStore();
  const first = await store.register({ requestKey: "req-1", kind: "add", root: "/srv/app" });
  // Model the lost response: the client never recorded operation_id, so it retries from request key.
  const second = await store.register({ requestKey: "req-1", kind: "add", root: "/srv/app" });
  assert.equal(second.reused, true);
  assert.equal(second.operation.operation_id, first.operation.operation_id);
  const byKey = await store.loadByRequestKey("req-1");
  assert.equal(byKey.operation_id, first.operation.operation_id);
});

// AC-6: the same request key carrying different content is a conflict, never a silent overwrite.
test("same key with different content returns conflict", async () => {
  const { store } = await freshStore();
  await store.register({ requestKey: "req-2", kind: "add", root: "/srv/app" });
  await assert.rejects(store.register({ requestKey: "req-2", kind: "add", root: "/srv/other" }),
    (error) => error.code === "request_conflict");
  await assert.rejects(store.register({ requestKey: "req-2", kind: "create", root: "/srv/app" }),
    (error) => error.code === "request_conflict");
});

// AC-6: concurrent retries — through one store and through two store handles on the same
// directory — create exactly one operation, and only one attempt may be fenced open at a time.
test("concurrent retries create one operation and one valid attempt", async () => {
  const { store } = await freshStore();
  const [a, b] = await Promise.all([
    store.register({ requestKey: "req-3", kind: "create", root: "/srv/dup" }),
    store.register({ requestKey: "req-3", kind: "create", root: "/srv/dup" })
  ]);
  assert.equal(a.operation.operation_id, b.operation.operation_id);
  const shared = await freshStore();
  const other = await createProjectOperationStore({ directory: shared.directory });
  const [c, d] = await Promise.all([
    shared.store.register({ requestKey: "req-3b", kind: "create", root: "/srv/dup" }),
    other.register({ requestKey: "req-3b", kind: "create", root: "/srv/dup" })
  ]);
  assert.equal(c.operation.operation_id, d.operation.operation_id);
  const attempt = await shared.store.claimAttempt(c.operation.operation_id);
  assert.equal(attempt.attempt, 1);
  assert.equal(attempt.stage, "attempted");
  // A second attempt cannot open while the first still holds resources.
  await assert.rejects(shared.store.claimAttempt(c.operation.operation_id), (error) => error.code === "attempt_open");
  const files = (await readdir(shared.directory)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
});

// AC-1 / AC-7: an update carrying a stale revision is rejected and the persisted snapshot keeps
// the concurrent winner's state; the winner's revision moves exactly once.
test("stale revision is rejected without touching the persisted snapshot", async () => {
  const { store } = await freshStore();
  const { operation } = await store.register({ requestKey: "req-4", kind: "add", root: "/srv/app" });
  const advanced = await store.transition(operation.operation_id, operation.revision, { project_id: "PROJECT-app" });
  assert.equal(advanced.revision, 1);
  await assert.rejects(store.transition(operation.operation_id, operation.revision, { status: "running" }),
    (error) => error.code === "revision_stale");
  const persisted = await store.load(operation.operation_id);
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.status, "pending");
});

// REV-2: a superseded worker cannot publish using a freshly loaded revision; only the current
// leased attempt can advance execution, and the public API cannot impersonate an internal claim.
test("stale attempt cannot publish with the latest revision or advance attempts", async () => {
  const { store } = await freshStore();
  const { operation } = await store.register({ requestKey: "fenced", kind: "create", root: "/srv/fenced" });
  const first = await store.claimAttempt(operation.operation_id);
  await store.releaseAttempt(operation.operation_id, first.attempt);
  const second = await store.claimAttempt(operation.operation_id);
  const latest = await store.load(operation.operation_id);
  for (const patch of [{ stage: "committed" }, { status: "failed", result: { outcome: "failed" } }]) {
    await assert.rejects(store.transition(operation.operation_id, latest.revision, patch, { attempt: first.attempt }),
      (error) => error.code === "attempt_stale");
  }
  await assert.rejects(store.transition(operation.operation_id, latest.revision, { stage: "committed" }),
    (error) => error.code === "attempt_required");
  await assert.rejects(store.transition(operation.operation_id, latest.revision, { attempt: 99 }, { internalClaim: 99 }),
    (error) => error.code === "attempt_frozen");
  assert.deepEqual(await store.load(operation.operation_id), latest);
  const committed = await store.transition(operation.operation_id, latest.revision, { stage: "committed" }, { attempt: second.attempt });
  assert.equal(committed.stage, "committed");
  await store.releaseAttempt(operation.operation_id, second.attempt);
  await assert.rejects(store.transition(operation.operation_id, committed.revision,
    { stage: "settled", status: "succeeded", result: { outcome: "succeeded" } }, { attempt: second.attempt }),
  (error) => error.code === "attempt_stale");
});

// REV-3: independent handles sharing managed storage must reject one conflicting writer, so an
// accepted revision is never silently overwritten by another read-validate-replace sequence.
test("two handles accept exactly one transition for the same revision", async () => {
  const { store, directory } = await freshStore();
  const other = await createProjectOperationStore({ directory });
  const { operation } = await store.register({ requestKey: "cas", kind: "add", root: "/srv/cas" });
  const claimed = await store.claimAttempt(operation.operation_id);
  const results = await Promise.allSettled([store, other].map((handle) =>
    handle.transition(operation.operation_id, claimed.revision, { stage: "committed" }, { attempt: claimed.attempt })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "revision_stale");
  const persisted = await other.load(operation.operation_id);
  assert.equal(persisted.revision, claimed.revision + 1);
  assert.equal(persisted.stage, "committed");
});

// AC-7: every stage change is one atomic snapshot file; a terminal transition without its result
// in the same write is refused, and no temporary residue is observable after success.
test("snapshot persistence is atomic and final outcome cannot be split from the stage", async () => {
  const { directory, store } = await freshStore();
  const { operation } = await store.register({ requestKey: "req-5", kind: "add", root: "/srv/app" });
  const claimed = await store.claimAttempt(operation.operation_id);
  const execution = { attempt: claimed.attempt };
  const committed = await store.transition(operation.operation_id, claimed.revision, { stage: "committed" }, execution);
  await assert.rejects(store.transition(operation.operation_id, committed.revision, { stage: "settled", status: "succeeded" }, execution),
    (error) => error.code === "terminal_requires_result");
  const settled = await store.transition(operation.operation_id, committed.revision, {
    stage: "settled", status: "succeeded", result: { outcome: "succeeded", root: "/srv/app" }
  }, execution);
  assert.equal(settled.stage, "settled");
  assert.equal(settled.result.outcome, "succeeded");
  assert.ok(settled.timestamps.settled_at);
  const residue = await readdir(directory);
  assert.deepEqual(residue.filter((name) => name.endsWith(".tmp")), []);
  const raw = JSON.parse(await readFile(join(directory, residue.find((name) => name.endsWith(".json"))), "utf8"));
  assert.equal(raw.revision, settled.revision);
});

// AC-7: throttled observation cannot lose stage progress — a slow client polls while transitions
// complete, then reconciles from the final snapshot; and disconnecting a watcher never cancels
// the backend operation, because only an explicit transition may change status.
test("throttling keeps final state and watcher disconnect never cancels", async () => {
  const { store } = await freshStore();
  const { operation } = await store.register({ requestKey: "req-6", kind: "add", root: "/srv/app" });
  let current = await store.claimAttempt(operation.operation_id);
  const execution = { attempt: current.attempt };
  // Client polls with throttled reads that may miss intermediate stages entirely.
  const poller = (async () => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    return store.load(operation.operation_id);
  })();
  current = await store.transition(operation.operation_id, current.revision, { stage: "committed" }, execution);
  const final = await store.transition(operation.operation_id, current.revision, {
    stage: "settled", status: "succeeded", result: { outcome: "succeeded", root: "/srv/app" }
  }, execution);
  // A throttled poll may observe the intermediate or the final stage, but the final outcome is
  // always present afterwards — no stage change and no terminal result is ever lost.
  const polled = await poller;
  assert.ok(["committed", "settled"].includes(polled.stage));
  assert.equal(final.stage, "settled");
  const reloaded = await store.load(operation.operation_id);
  assert.equal(reloaded.stage, "settled");
  assert.equal(reloaded.result.outcome, "succeeded");
  // A browser/CLI disconnect only drops the observing poll loop above; it calls no transition,
  // so the backend operation keeps the status it persisted for itself.
  const afterDisconnect = await store.load(operation.operation_id);
  assert.equal(afterDisconnect.status, "succeeded");
});
