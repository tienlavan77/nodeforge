// Checks real permission failures and guarantees NodeForge probes do not modify source.
// Permission expectations follow the effective principal, including environments with elevated access.
import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { safetyFixture } from "./project-filesystem-safety-support.js";
import { captureRoot, preflightSource } from "../../src/modules/projects/project-filesystem-safety.js";

test("source read/traverse permission failures have source diagnostics and never start services", async (t) => {
  const f = await safetyFixture(t);
  const path = join(f.root, "private.js");
  await writeFile(path, "export const privateValue = 1;");
  await chmod(path, 0);

  let readable = true;
  try { await access(path, constants.R_OK); } catch (error) { assert.equal(error.code, "EACCES"); readable = false; }
  if (readable) await preflightSource(await captureRoot(f.root));
  else {
    await assert.rejects(f.lifecycle.add(f.root), { stage: "source", code: "source_unreadable" });
    assert.equal(f.starts(), 0);
  }
});

test("managed runtime permission failures are distinct from source failures", async (t) => {
  const f = await safetyFixture(t);
  const runtime = join(f.root, ".forge", "runtime");
  await mkdir(runtime, { recursive: true });
  await chmod(runtime, 0o500);

  let writable = true;
  try { await access(runtime, constants.W_OK); } catch (error) { assert.equal(error.code, "EACCES"); writable = false; }
  if (writable) await f.lifecycle.add(f.root);
  else {
    await assert.rejects(f.lifecycle.add(f.root), { stage: "runtime", code: "runtime_unwritable" });
    assert.equal(f.starts(), 0);
  }
});

test("write probes leave source bytes and source directory entries unchanged", async (t) => {
  const f = await safetyFixture(t);
  const path = join(f.root, "sample.js");
  await writeFile(path, "export const stable = true;");
  const before = await readFile(path);
  await f.lifecycle.add(f.root);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual((await readdir(f.root)).sort(), [".forge", "sample.js"]);
  assert(!(await readdir(join(f.root, ".forge", "runtime"))).some((name) => name.includes("probe")));
});

test("linked NodeForge storage cannot redirect identity writes outside the selected root", async (t) => {
  const f = await safetyFixture(t);
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.root, ".forge"));
  await assert.rejects(f.lifecycle.add(f.root), { code: "storage_replaced" });
  assert.deepEqual(await readdir(outside), []);
  assert.equal(f.starts(), 0);
});

test("missing Create parents and unwritable existing parents never trigger recursive ancestor creation", async (t) => {
  const f = await safetyFixture(t);
  const parent = join(f.directory, "locked");
  await mkdir(parent);
  await chmod(parent, 0o500);

  let writable = true;
  try { await access(parent, constants.W_OK); } catch (error) { assert.equal(error.code, "EACCES"); writable = false; }
  const root = join(parent, "new");
  if (writable) await f.lifecycle.create(root);
  else {
    await assert.rejects(f.lifecycle.create(root), { stage: "parent" });
    await assert.rejects(lstat(root), { code: "ENOENT" });
  }
});
