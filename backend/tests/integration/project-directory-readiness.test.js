// Verifies membership survives startup failure while current-process readiness and diagnostics
// follow the latest retry. Real catalog, identity, filesystem and index fixtures exercise admission.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./multi-project-lifecycle-support.js";
import { createProjectDirectoryState } from "../../src/modules/projects/project-directory-state.js";
import { createProjectAdmissionQueue } from "../../src/modules/projects/project-admission-queue.js";

test("startup failure retains identity; retry replaces diagnostics and restores admission", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let fail = true;
  const manager = await f.open({ startRuntime: async ({ projectId, projectRoot }) => {
    if (fail) throw new Error("private startup detail");
    return { projectId, projectRoot, close() {}, status: () => ({ closed: false }) };
  } });
  await assert.rejects(manager.add(f.roots[0]), /private startup detail/);
  const failed = manager.directory()[0];
  assert.ok(failed.projectId);
  assert.equal(failed.readiness, "unavailable");
  assert.equal(failed.operation.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(manager.list().length, 0);
  assert.equal(await manager.get(f.roots[0]), undefined);
  assert.doesNotMatch(JSON.stringify(failed), /private startup detail/);
  fail = false;
  await manager.add(f.roots[0]);
  const ready = manager.directory()[0];
  assert.equal(ready.projectId, failed.projectId);
  assert.equal(ready.operation.attempt_id, failed.operation.attempt_id + 1);
  assert.equal(ready.readiness, "ready");
  assert.equal(ready.diagnostic, null);
  assert.equal(ready.retryable, false);
  await manager.close();
  const restored = await f.open({ startRuntime: async () => { throw new Error("restart failed"); } });
  assert.equal(restored.directory()[0].projectId, ready.projectId);
  assert.equal(restored.directory()[0].readiness, "unavailable");
});

// Blocks startup until both canonical aliases have joined, proving failure is shared and
// a later explicit request alone advances the directory attempt and clears its diagnostic.
test("concurrent canonical retries share rejection and permit a later attempt", async () => {
  const entry = { root: "/project", projectId: "PROJECT-A" };
  const state = createProjectDirectoryState({ catalog: { list: () => [entry] }, runtimes: new Map(), isAvailable: () => false, isClosed: () => false });
  let rejectStartup;
  let starts = 0;
  let tail = Promise.resolve();
  const failure = new Error("blocked startup failed");
  const add = createProjectAdmissionQueue({
    canonicalRoot: async () => entry.root,
    // Preserves the production queue's failure recovery, which previously allowed duplicate retries.
    enqueue(operation) {
      const result = tail.then(operation);
      tail = result.catch((error) => { assert.equal(error, failure); });
      return result;
    },
    // Exercises actual attempt state while controlling startup settlement without timers.
    admit: () => state.run(entry.root, () => {
      starts += 1;
      return new Promise((resolve, reject) => { rejectStartup = reject; });
    })
  });
  const first = add("/project");
  const second = add("/alias");
  const results = Promise.allSettled([first, second]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(state.directory()[0].operation.attempt_id, 1);
  rejectStartup(failure);
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, failure);
  }
  assert.equal(starts, 1);
  assert.equal(state.directory()[0].operation.status, "failed");
  assert.equal(state.directory()[0].operation.attempt_id, 1);
  const retry = add("/project");
  const rejected = assert.rejects(retry, (error) => error === failure);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts, 2);
  rejectStartup(failure);
  await rejected;
  assert.equal(state.directory()[0].operation.attempt_id, 2);
});

// Verifies real filesystem canonicalization and lifecycle wiring retain one failed card
// for concurrent retry requests and allow the next explicit retry to restore readiness.
test("lifecycle coalesces concurrent failing retries and later recovers", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let starts = 0;
  let rejectStartup;
  let startupEntered;
  const entered = new Promise((resolve) => { startupEntered = resolve; });
  const manager = await f.open({ startRuntime: async ({ projectId, projectRoot }) => {
    starts += 1;
    if (starts === 1) throw new Error("initial failure");
    if (starts === 2) {
      startupEntered();
      await new Promise((resolve, reject) => { rejectStartup = reject; });
    }
    // Supplies the runtime contract needed to observe readiness after the explicit recovery.
    return { projectId, projectRoot, close() {}, status: () => ({ closed: false }) };
  } });
  await assert.rejects(manager.add(f.roots[0]), /initial failure/);
  const failed = manager.directory()[0];
  const results = Promise.allSettled([manager.add(f.roots[0]), manager.add(f.roots[0] + "/.")]);
  await entered;
  assert.equal(manager.directory()[0].operation.attempt_id, failed.operation.attempt_id + 1);
  rejectStartup(new Error("shared failure"));
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /shared failure/);
  }
  assert.equal(starts, 2);
  assert.equal(manager.directory()[0].operation.attempt_id, failed.operation.attempt_id + 1);
  assert.equal(manager.directory()[0].projectId, failed.projectId);
  await manager.add(f.roots[0]);
  assert.equal(starts, 3);
  assert.equal(manager.directory()[0].operation.attempt_id, failed.operation.attempt_id + 2);
  assert.equal(manager.directory()[0].diagnostic, null);
  assert.equal(manager.directory()[0].readiness, "ready");
});

test("older attempt completion cannot overwrite the current retry", async () => {
  const entry = { root: "/project", projectId: "PROJECT-A" };
  const state = createProjectDirectoryState({ catalog: { list: () => [entry] }, runtimes: new Map(), isAvailable: () => false, isClosed: () => false });
  let finish;
  const old = state.run(entry.root, () => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(state.run(entry.root, async () => { throw new Error("failed"); }));
  finish();
  await old;
  assert.equal(state.directory()[0].operation.status, "failed");
  assert.equal(state.directory()[0].operation.attempt_id, 2);
});
