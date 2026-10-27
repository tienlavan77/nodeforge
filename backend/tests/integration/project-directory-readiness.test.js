// Verifies membership survives startup failure while current-process readiness and diagnostics
// follow the latest retry. Real catalog, identity, filesystem and index fixtures exercise admission.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./multi-project-lifecycle-support.js";
import { createProjectDirectoryState } from "../../src/modules/projects/project-directory-state.js";

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
