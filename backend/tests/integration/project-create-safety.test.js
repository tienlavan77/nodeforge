// Verifies exclusive Create admission, durable ownership failures, and membership-before-startup.
// These scenarios use real directories and the accepted operation store instead of source assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { safetyFixture } from "./project-filesystem-safety-support.js";
import { createProjectOperationStore } from "../../src/modules/projects/project-operation-store.js";

test("an EEXIST race after preflight cannot take over the winning directory", async (t) => {
  const f = await safetyFixture(t);
  const root = join(f.directory, "race-winner");
  const store = await createProjectOperationStore({ directory: join(f.directory, "race-operations") });
  const { createProjectLifecycle } = await import("../../src/modules/projects/project-lifecycle.js");
  const manager = await createProjectLifecycle({
    catalogPath: join(f.directory, "race-catalog.json"), logger: { error() {} },
    operationStore: { ...store,
      // Models another actor creating the target after preflight but before the exclusive mkdir.
      async claimAttempt(id) { await mkdir(root); return store.claimAttempt(id); }
    },
    // Any startup here would prove that Create silently adopted the race winner.
    startRuntime: async () => assert.fail("Create must not adopt an EEXIST winner")
  });
  t.after(() => manager.close());
  await assert.rejects(manager.create(root), { code: "create_target_exists" });
  await assert.rejects(lstat(join(root, ".forge")), { code: "ENOENT" });
  assert.deepEqual(manager.list(), []);
});

test("Add cannot bypass a missing Create ownership checkpoint after restart", async (t) => {
  const f = await safetyFixture(t);
  const root = join(f.directory, "uncheckpointed");
  const catalogPath = join(f.directory, "uncertain-catalog.json");
  const store = await createProjectOperationStore({ directory: join(f.directory, "uncertain-operations") });
  const { createProjectLifecycle } = await import("../../src/modules/projects/project-lifecycle.js");
  const manager = await createProjectLifecycle({
    catalogPath, logger: { error() {} },
    operationStore: { ...store,
      // Simulates loss of the first durable ownership write after exclusive directory creation.
      async transition() { throw new Error("ownership checkpoint unavailable"); }
    },
    // An uncertain root must be reconciled before any startup can run.
    startRuntime: async () => assert.fail("uncertain Create must not start")
  });
  await assert.rejects(manager.create(root), { code: "create_ownership_uncertain" });
  await manager.close();
  const restored = await createProjectLifecycle({ catalogPath, operationStore: store, logger: { error() {} } });
  t.after(() => restored.close());
  await assert.rejects(restored.add(root), { code: "create_ownership_uncertain" });
  await assert.rejects(lstat(join(root, ".forge")), { code: "ENOENT" });
  assert.deepEqual(restored.list(), []);
});

test("Create requires an absolute Control API host path and an existing parent", async (t) => {
  const f = await safetyFixture(t);
  await assert.rejects(f.lifecycle.create("relative"), { code: "absolute_root_required" });
  const target = join(f.directory, "missing", "child");
  await assert.rejects(f.lifecycle.create(target), { code: "create_parent_missing" });
  await assert.rejects(lstat(join(f.directory, "missing")), { code: "ENOENT" });
  assert.equal(f.starts(), 0);
});

test("Create refuses empty directories, files and dangling symlinks without becoming Add", async (t) => {
  const f = await safetyFixture(t);
  const link = join(f.directory, "link");
  await symlink(join(f.directory, "absent"), link);
  for (const root of [f.root, link]) {
    await assert.rejects(f.lifecycle.create(root), { code: "create_target_exists" });
  }
  assert.equal(f.starts(), 0);
  await assert.rejects(lstat(join(f.root, ".forge")), { code: "ENOENT" });
});

test("Create commits identity and membership before startup and retains both after startup failure", async (t) => {
  const f = await safetyFixture(t, { startRuntime: async () => { throw new Error("index unavailable"); } });
  const root = join(f.directory, "created");
  await assert.rejects(f.lifecycle.create(root, { requestKey: "startup-failure" }), { code: "project_startup_failed" });
  const identity = JSON.parse(await readFile(join(root, ".forge", "runtime", "project.json"), "utf8"));
  assert.equal((await f.membership())[0].projectId, identity.project_id);
  assert((await lstat(root)).isDirectory());
  await assert.rejects(f.lifecycle.create(root, { requestKey: "startup-failure" }), { code: "create_target_exists" });
  assert.equal(f.starts(), 1);
});

test("Create succeeds with membership already visible to startup and never takes over on EEXIST", async (t) => {
  const f = await safetyFixture(t);
  const root = join(f.directory, "new");
  const entry = await f.lifecycle.create(root, { requestKey: "new-project" });
  assert.equal(entry.root, root);
  assert.equal((await f.membership()).length, 1);
  await assert.rejects(f.lifecycle.create(root), { code: "create_target_exists" });
  assert.equal(f.starts(), 1);
});

test("a lost ownership checkpoint preserves an uncertain directory and blocks takeover", async (t) => {
  const f = await safetyFixture(t, { lifecycle: { operationStore: {
    async register() { return { operation: { operation_id: "OPRO-failure" }, reused: false }; },
    async claimAttempt() { return { operation_id: "OPRO-failure", revision: 1, attempt: 1 }; },
    async transition() { throw new Error("checkpoint write failed"); },
    async releaseAttempt() {}
  } } });
  const root = join(f.directory, "uncertain");
  await assert.rejects(f.lifecycle.create(root), { code: "create_ownership_uncertain" });
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(root)), []);
  await assert.rejects(f.lifecycle.create(root), { code: "create_target_exists" });
  assert.equal(f.starts(), 0);
});

test("replacement after the ownership checkpoint cannot authorize identity or membership", async (t) => {
  const f = await safetyFixture(t);
  const root = join(f.directory, "replaced");
  const saved = join(f.directory, "original");
  const store = await createProjectOperationStore({ directory: join(f.directory, "operations") });
  const manager = await import("../../src/modules/projects/project-lifecycle.js").then(({ createProjectLifecycle }) =>
    createProjectLifecycle({ catalogPath: join(f.directory, "other-catalog.json"), logger: { error() {} },
      operationStore: { ...store, async transition(...args) {
        const next = await store.transition(...args);
        await rename(root, saved); await mkdir(root);
        return next;
      } }, startRuntime: async () => { assert.fail("replacement must not start"); } }));
  t.after(() => manager.close());
  await assert.rejects(manager.create(root), { code: "root_replaced" });
  await assert.rejects(lstat(join(root, ".forge")), { code: "ENOENT" });
  assert((await lstat(saved)).isDirectory());
});
