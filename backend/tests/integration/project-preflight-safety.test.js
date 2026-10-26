// Exercises Add identity integrity and catalog/startup ordering against real metadata and roots.
// Failures must preserve evidence while repeat admission must not create another runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safetyFixture } from "./project-filesystem-safety-support.js";

test("Add requires an existing absolute canonical directory", async (t) => {
  const f = await safetyFixture(t);
  await assert.rejects(f.lifecycle.add("source"), { code: "absolute_root_required" });
  await assert.rejects(f.lifecycle.add(join(f.directory, "absent")), { code: "invalid_project_root" });
  assert.equal(f.starts(), 0);
});

test("Add commits membership first and repeated Add starts no second watcher or index", async (t) => {
  const f = await safetyFixture(t);
  const first = await f.lifecycle.add(f.root);
  assert.deepEqual(await f.lifecycle.add(f.root), first);
  assert.equal(f.starts(), 1);
  assert.deepEqual(await f.membership(), [first]);
});

test("startup failure retains Add identity and membership for retry", async (t) => {
  let fail = true;
  const f = await safetyFixture(t, { startRuntime: async () => { if (fail) throw new Error("startup unavailable"); } });
  await assert.rejects(f.lifecycle.add(f.root), { code: "project_startup_failed" });
  const before = await readFile(join(f.root, ".forge", "runtime", "project.json"), "utf8");
  assert.equal((await f.membership()).length, 1);
  fail = false;
  await f.lifecycle.add(f.root);
  assert.equal(f.starts(), 2);
  assert.equal(await readFile(join(f.root, ".forge", "runtime", "project.json"), "utf8"), before);
});

test("copied metadata at another root is rejected without rewriting identity", async (t) => {
  const f = await safetyFixture(t);
  await f.lifecycle.add(f.root);
  const copy = join(f.directory, "copy");
  await cp(f.root, copy, { recursive: true });
  const path = join(copy, ".forge", "runtime", "project.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(f.lifecycle.add(copy), { code: "identity_conflict" });
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(f.starts(), 1);
});

test("catalog identity mismatch is rejected without rewriting per-root metadata", async (t) => {
  const f = await safetyFixture(t);
  await f.lifecycle.add(f.root);
  const path = join(f.root, ".forge", "runtime", "project.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  metadata.project_id = "PROJECT-conflict";
  await writeFile(path, JSON.stringify(metadata));
  const before = await readFile(path, "utf8");
  await assert.rejects(f.lifecycle.add(f.root), { code: "identity_conflict" });
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(f.starts(), 1);
});

test("a replaced root with copied metadata fails its inode checkpoint even when already serving", async (t) => {
  const f = await safetyFixture(t);
  await f.lifecycle.add(f.root);
  const saved = join(f.directory, "saved");
  await rename(f.root, saved);
  await cp(saved, f.root, { recursive: true });
  await assert.rejects(f.lifecycle.add(f.root), { code: "identity_conflict" });
  assert.equal(f.starts(), 1);
});

test("catalog write failure prevents startup and leaves source and identity available", async (t) => {
  const f = await safetyFixture(t);
  await mkdir(f.catalogPath, { recursive: true });
  await assert.rejects(f.lifecycle.add(f.root), { stage: "catalog" });
  assert.equal(f.starts(), 0);
  const metadata = JSON.parse(await readFile(join(f.root, ".forge", "runtime", "project.json"), "utf8"));
  assert.equal(metadata.root, f.root);
});
