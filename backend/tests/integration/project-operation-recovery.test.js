// Restart reconciliation and recovery acceptance for durable project lifecycle operations
// (TICKET-NF-CA-OPERATION AC-3, AC-4, AC-5, AC-8, AC-9, AC-10, AC-11).
// Business purpose: after a restart the backend must reconcile catalog, identity, artifact
// ownership and database results before recovery, because a failed or delayed snapshot must never
// remove membership, replay an already committed Create, or infer success from intent; a re-run is
// allowed only when the previous attempt released its resources, and serving readiness must be
// re-probed live instead of trusting any stored flag. Technical description: each scenario opens a
// process over a shared mkdtemp directory (a reopen models a restart), drives the recovery
// coordinator with scripted evidence probes, and asserts which probes were called plus the exact
// persisted snapshot outcome afterwards. Catalog replace is counted to prove recovery never
// rewrote the authoritative membership source.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectOperationStore } from "../../src/modules/projects/project-operation-store.js";
import { createProjectOperationRecovery } from "../../src/modules/projects/project-operation-recovery.js";
import { computeRequestFingerprint } from "../../src/modules/projects/project-operation-contract.js";

// Opens one simulated process over the durable directory: fresh store plus a recovery coordinator
// whose evidence probes record every call for later assertions.
async function openProcess(directory, { entries = [], results = {}, ownership = new Set(), serving = { ready: true } }) {
  const store = await createProjectOperationStore({ directory });
  const calls = { identity: [], ownership: [], result: [], serving: [], catalogReplace: 0 };
  const catalog = Object.freeze({
    list: () => entries.map(({ root, projectId }) => ({ root, projectId })),
    replace: async () => { calls.catalogReplace += 1; }
  });
  const recovery = createProjectOperationRecovery({
    store, catalog,
    identity: { resolve: async (root) => { calls.identity.push(root); return entries.find((entry) => entry.root === root)?.projectId ?? null; } },
    ownsArtifact: async ({ projectId }) => { calls.ownership.push(projectId); return ownership.has(projectId); },
    queryResult: async ({ operationId }) => { calls.result.push(operationId); return results[operationId] ?? null; },
    verifyServing: async (input) => { calls.serving.push(input); return serving; }
  });
  return { store, recovery, calls };
}

// Starts a scenario on a fresh managed-storage directory; the directory is returned so a later
// openProcess call can model a full process restart sharing only the durable files.
async function scenario(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "operation-recovery-"));
  const first = await openProcess(directory, options);
  return { directory, ...first };
}

// AC-3 / AC-9 / AC-11: on restart, committed work is settled from catalog+identity+ownership
// evidence and an attempt with a recorded failed database result is settled as failed — neither is
// replayed, no second runtime is opened, and the authoritative catalog is never rewritten.
test("restart settles committed and failed work from evidence without replay", async () => {
  const results = {};
  const { store, recovery, calls } = await scenario({
    entries: [
      { root: "/srv/a", projectId: "PROJECT-a" },
      { root: "/srv/b", projectId: "PROJECT-b" }
    ],
    results,
    ownership: new Set(["PROJECT-a"])
  });
  const committed = await store.register({ requestKey: "req-r1", kind: "create", root: "/srv/a", projectId: "PROJECT-a" });
  const claimA = await store.claimAttempt(committed.operation.operation_id);
  await store.transition(committed.operation.operation_id, claimA.revision, { stage: "committed" }, { attempt: claimA.attempt });
  await store.releaseAttempt(committed.operation.operation_id, claimA.attempt);
  const prior = await store.register({ requestKey: "req-r2", kind: "add", root: "/srv/b", projectId: "PROJECT-b" });
  const claimB = await store.claimAttempt(prior.operation.operation_id);
  await store.releaseAttempt(prior.operation.operation_id, claimB.attempt);
  results[prior.operation.operation_id] = { outcome: "failed" };

  const { decisions } = await recovery.recover();
  const settledA = decisions.find((d) => d.operation_id === committed.operation.operation_id);
  assert.equal(settledA.action, "settled_from_evidence");
  assert.equal(settledA.outcome, "succeeded");
  const settledB = decisions.find((d) => d.operation_id === prior.operation.operation_id);
  assert.equal(settledB.action, "settled_from_evidence");
  assert.equal(settledB.outcome, "failed");
  const persistedA = await store.load(committed.operation.operation_id);
  assert.equal(persistedA.stage, "settled");
  assert.equal(persistedA.counters.attempts, 1);
  assert.equal(persistedA.result.outcome, "succeeded");
  const persistedB = await store.load(prior.operation.operation_id);
  assert.equal(persistedB.stage, "settled");
  assert.equal(persistedB.status, "failed");
  assert.ok(persistedB.result.outcome);
  assert.deepEqual(calls.identity.sort(), ["/srv/a", "/srv/b"]);
  assert.deepEqual(calls.ownership, ["PROJECT-a"]);
  assert.equal(calls.serving.length, 0);
  assert.equal(calls.catalogReplace, 0);
});

// AC-4 / AC-10: recovery may re-run an unfinished step, but never opens a new attempt while the
// previous one still holds unreleased resources; after release, a later sweep replays with a
// fenced higher attempt and a live serving probe.
test("open attempt lease blocks a new runtime until resources are released", async () => {
  const { store, recovery, calls } = await scenario({ entries: [{ root: "/srv/a", projectId: "PROJECT-a" }] });
  const { operation } = await store.register({ requestKey: "req-r3", kind: "add", root: "/srv/a", projectId: "PROJECT-a" });
  await store.claimAttempt(operation.operation_id);
  const blocked = await recovery.recover();
  assert.equal(blocked.decisions[0].action, "blocked_attempt_open");
  assert.deepEqual(blocked.decisions[0].held_attempts, [1]);
  assert.equal(calls.serving.length, 0);
  assert.deepEqual(await store.openAttempts(), [{ operationId: operation.operation_id, attempts: [1] }]);
  await store.releaseAttempt(operation.operation_id, 1);
  const replayed = await recovery.recover();
  assert.equal(replayed.decisions[0].action, "replayed");
  assert.equal(replayed.decisions[0].new_attempt, 2);
  assert.equal(calls.serving.length, 1);
  const persisted = await store.load(operation.operation_id);
  assert.equal(persisted.attempt, 2);
  assert.equal(persisted.status, "running");
});

// AC-5: serving readiness is re-verified in the current process. Even when the persisted snapshot
// file carries an extra ready field, recovery ignores it and probes live; a failed probe claims no
// attempt, so no resources are opened behind the fence.
test("stored ready flag is ignored in favor of a live probe and failed probe claims nothing", async () => {
  const { store, directory } = await scenario({ entries: [] });
  const { operation } = await store.register({ requestKey: "req-r4", kind: "add", root: "/srv/cold" });
  const name = await findSnapshotFile(directory, operation.operation_id);
  const snapshot = JSON.parse(await readFile(join(directory, name), "utf8"));
  await writeFile(join(directory, name), JSON.stringify({ ...snapshot, ready: true, ready_at: "2026-01-01T00:00:00.000Z" }), "utf8");
  const restarted = await openProcess(directory, {
    entries: [], serving: { ready: false, reason: "runtime cold" }
  });
  const { decisions } = await restarted.recovery.recover();
  assert.equal(decisions[0].action, "blocked_not_serving");
  assert.equal(decisions[0].detail, "runtime cold");
  assert.equal(restarted.calls.serving.length, 1);
  assert.deepEqual(await restarted.store.openAttempts(), []);
  const persisted = await restarted.store.load(operation.operation_id);
  assert.equal(persisted.attempt, 0);
  assert.equal(persisted.stage, "intended");
});

// AC-8: catalog is the source of membership. Corrupt snapshot files are reported and skipped,
// never triggering a catalog rewrite, and a healthy operation still recovers in the same sweep.
test("corrupt snapshots are skipped while membership survives and healthy work recovers", async () => {
  const entries = [{ root: "/srv/healthy", projectId: "PROJECT-healthy" }];
  const { store, directory } = await scenario({ entries });
  const doomed = await store.register({ requestKey: "req-r5", kind: "create", root: "/srv/healthy", projectId: "PROJECT-healthy" });
  await store.claimAttempt(doomed.operation.operation_id);
  const healthy = await store.register({ requestKey: "req-r6", kind: "add", root: "/srv/healthy" });
  const doomedFile = await findSnapshotFile(directory, doomed.operation.operation_id);
  await writeFile(join(directory, doomedFile), "{ truncated write", "utf8");
  await writeFile(join(directory, `${computeRequestFingerprint({ kind: "add", root: "/srv/x" })}.json`),
    JSON.stringify({ operation_id: "OPRO-notreal", stage: "intended" }), "utf8");
  const restarted = await openProcess(directory, { entries });
  const { decisions, corrupted } = await restarted.recovery.recover();
  assert.equal(corrupted.length, 2);
  assert.deepEqual(decisions.map((d) => d.operation_id), [healthy.operation.operation_id]);
  assert.equal(decisions[0].action, "replayed");
  assert.equal(restarted.calls.catalogReplace, 0);
});

// AC-8 / AC-11: a committed snapshot that lost catalog membership fails closed for humans instead
// of trusting the stale snapshot, and a plain intent never becomes success — it is only replayed.
test("intent never becomes success and lost committed membership fails closed", async () => {
  const { store, recovery } = await scenario({ entries: [] });
  const lost = await store.register({ requestKey: "req-r7", kind: "create", root: "/srv/lost", projectId: "PROJECT-lost" });
  const claim = await store.claimAttempt(lost.operation.operation_id);
  await store.transition(lost.operation.operation_id, claim.revision, { stage: "committed" }, { attempt: claim.attempt });
  await store.releaseAttempt(lost.operation.operation_id, claim.attempt);
  const intent = await store.register({ requestKey: "req-r8", kind: "add", root: "/srv/grow" });
  const { decisions } = await recovery.recover();
  assert.equal(decisions.find((d) => d.operation_id === lost.operation.operation_id).action, "blocked_membership_lost");
  const persistedLost = await store.load(lost.operation.operation_id);
  assert.equal(persistedLost.stage, "committed");
  assert.notEqual(persistedLost.status, "succeeded");
  const intentDecision = decisions.find((d) => d.operation_id === intent.operation.operation_id);
  assert.equal(intentDecision.action, "replayed");
  const persistedIntent = await store.load(intent.operation.operation_id);
  assert.equal(persistedIntent.stage, "attempted");
  assert.equal(persistedIntent.result, undefined);
});

// REV-1: catalog membership plus identity and ownership proves Create committed even if a crash
// left its snapshot at intended or attempted. Restart must settle without claiming or replaying.
test("catalog commit settles lagging Create snapshots without replay", async () => {
  for (const stage of ["intended", "attempted"]) {
    const entries = [{ root: "/srv/lagging", projectId: "PROJECT-lagging" }];
    const { directory, store } = await scenario({ entries, ownership: new Set(["PROJECT-lagging"]) });
    const { operation } = await store.register({ requestKey: "lagging", kind: "create", root: "/srv/lagging" });
    if (stage === "attempted") {
      const claimed = await store.claimAttempt(operation.operation_id);
      await store.releaseAttempt(operation.operation_id, claimed.attempt);
    }
    const restarted = await openProcess(directory, { entries, ownership: new Set(["PROJECT-lagging"]) });
    const { decisions } = await restarted.recovery.recover();
    assert.equal(decisions[0].action, "settled_from_evidence");
    const persisted = await restarted.store.load(operation.operation_id);
    assert.equal(persisted.result.outcome, "succeeded");
    assert.equal(persisted.attempt, stage === "attempted" ? 1 : 0);
    assert.deepEqual(await restarted.store.openAttempts(), []);
    assert.equal(restarted.calls.serving.length, 0);
    assert.equal(restarted.calls.catalogReplace, 0);
  }
});

// REV-1: database success cannot manufacture membership or excuse missing ownership. Conflicting
// evidence must preserve the snapshot and avoid both settlement and a replacement runtime.
test("database success conflicting with membership or ownership fails closed", async () => {
  for (const membership of [false, true]) {
    const results = {};
    const entries = membership ? [{ root: "/srv/conflict", projectId: "PROJECT-conflict" }] : [];
    const { store, recovery, calls } = await scenario({
      entries, results, ownership: new Set(membership ? [] : ["PROJECT-conflict"])
    });
    const { operation } = await store.register({
      requestKey: "conflict", kind: "create", root: "/srv/conflict", projectId: "PROJECT-conflict"
    });
    results[operation.operation_id] = { outcome: "succeeded" };
    const { decisions } = await recovery.recover();
    assert.equal(decisions[0].action, "blocked_evidence_conflict");
    assert.deepEqual(await store.load(operation.operation_id), operation);
    assert.deepEqual(await store.openAttempts(), []);
    assert.equal(calls.serving.length, 0);
    assert.equal(calls.catalogReplace, 0);
  }
});

// Finds the persisted snapshot filename for one operation id so tests can damage or inspect it.
async function findSnapshotFile(directory, operationId) {
  const names = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
  for (const name of names) {
    try {
      const snapshot = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (snapshot.operation_id === operationId) return name;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw new Error(`No snapshot file for ${operationId}`);
}
