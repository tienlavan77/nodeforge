// Verifies actionable principal diagnostics and safe cleanup in the actual verification environment.
// A replacement during a probe must preserve the uncertain artifact rather than unlink through a new root.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { safetyFixture } from "./project-filesystem-safety-support.js";
import { assertRoot, captureRoot, filesystemError, probeStorage } from "../../src/modules/projects/project-filesystem-safety.js";

test("diagnostics identify stage, code, location, retry guidance and effective principal", () => {
  for (const stage of ["input", "identity", "source", "runtime", "catalog", "operation_store", "cleanup"]) {
    const error = filesystemError(stage, `${stage}_failure`, "/selected/root", new Error("probe failed"));
    assert.equal(error.stage, stage);
    assert.equal(error.code, `${stage}_failure`);
    assert.equal(error.path, "/selected/root");
    assert.equal(typeof error.retryable, "boolean");
    assert(error.guidance.length > 0);
    assert.equal(error.principal.uid, process.geteuid?.() ?? "unknown");
    assert.equal(error.principal.gid, process.getegid?.() ?? "unknown");
    assert.equal(error.ownership, "unknown");
    assert.match(error.message, /probe failed/);
  }
});

test("successful probes remove only their own temporary NodeForge artifact", async (t) => {
  const f = await safetyFixture(t);
  const binding = await captureRoot(f.root);
  await probeStorage(f.root, "runtime", () => assertRoot(binding));
  assert.deepEqual(await readdir(f.root), []);
});

test("probe cleanup fails closed when the selected directory is replaced", async (t) => {
  const f = await safetyFixture(t);
  const binding = await captureRoot(f.root);
  const saved = join(f.directory, "saved-probe");
  let calls = 0;
  await assert.rejects(probeStorage(f.root, "runtime", async () => {
    calls++;
    if (calls === 2) { await rename(f.root, saved); await mkdir(f.root); }
    await assertRoot(binding);
  }), { stage: "cleanup", code: "probe_cleanup_failed" });
  assert.deepEqual(await readdir(f.root), []);
  assert.equal((await readdir(saved)).filter((name) => name.startsWith(".nodeforge-probe-")).length, 1);
});

test("operation-store failure occurs before Create makes the target directory", async (t) => {
  const f = await safetyFixture(t, { lifecycle: { operationStore: {
    async register() { throw new Error("operation store read-only"); }
  } } });
  const root = join(f.directory, "not-created");
  await assert.rejects(f.lifecycle.create(root), { stage: "operation_store", code: "operation_store_unwritable" });
  assert(!(await readdir(f.directory)).includes("not-created"));
  assert.equal(f.starts(), 0);
});
