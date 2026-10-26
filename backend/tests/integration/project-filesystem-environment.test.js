// Verifies actionable principal diagnostics and safe cleanup in the actual verification environment.
// A replacement during a probe must preserve the uncertain artifact rather than unlink through a new root.
import test from "node:test";
import assert from "node:assert/strict";
import { access, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { safetyFixture } from "./project-filesystem-safety-support.js";
import { assertRoot, captureRoot, filesystemError, preflightSource, prepareStorage, probeStorage } from "../../src/modules/projects/project-filesystem-safety.js";

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

// Requires externally provisioned, disposable Linux fixtures so permission, mount and
// capacity coverage cannot silently become ordinary temporary-directory coverage.
// NODEFORGE_FILESYSTEM_FIXTURES names a JSON file with acl, readonly and capacity entries;
// each entry supplies canonical root and a readable sourceFile relative to that root.
// The acl entry also supplies deniedFile, a mode-readable file blocked by a real ACL.
// The readonly and capacity roots must already contain .forge/runtime. Provisioning,
// privilege changes and mount/ACL configuration remain the verification host's responsibility.
for (const kind of ["acl", "readonly", "capacity"]) {
  test(`real filesystem environment: ${kind} denial blocks preflight and Add`, async (t) => {
    const manifestPath = process.env.NODEFORGE_FILESYSTEM_FIXTURES;
    assert(manifestPath, "VERIFICATION_BLOCKED: provision NODEFORGE_FILESYSTEM_FIXTURES (acl, readonly, capacity); synthetic errors do not establish coverage");
    const fixtures = JSON.parse(await readFile(manifestPath, "utf8"));
    const fixture = fixtures[kind];
    assert(fixture?.root && fixture.sourceFile, `VERIFICATION_BLOCKED: missing ${kind} fixture`);
    const binding = await captureRoot(fixture.root);
    const status = await readFile("/proc/self/status", "utf8");
    const credentials = Object.fromEntries(status.split("\n").filter((line) => /^(Uid|Gid|Groups|CapEff):/.test(line))
      .map((line) => [line.split(":")[0], line.slice(line.indexOf(":") + 1).trim()]));
    assert.equal(Number(credentials.Uid.split(/\s+/)[1]), process.geteuid());
    assert.equal(Number(credentials.Gid.split(/\s+/)[1]), process.getegid());
    assert.notEqual(process.geteuid(), 0, "VERIFICATION_BLOCKED: real denials require an unprivileged principal");
    assert.equal(BigInt(`0x${credentials.CapEff}`), 0n, "VERIFICATION_BLOCKED: remove effective capabilities in the provisioned runner");
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    t.diagnostic(JSON.stringify({ kind, root: binding.root, credentials, mounts }));
    const sourcePath = join(binding.root, fixture.sourceFile);
    const before = await readFile(sourcePath);
    const entries = await readdir(binding.root);
    const runtime = join(binding.root, ".forge", "runtime");
    let deniedPath;
    let deniedInfo;
    if (kind === "acl") {
      assert(fixture.deniedFile, "VERIFICATION_BLOCKED: acl.deniedFile is required");
      deniedPath = join(binding.root, fixture.deniedFile);
      deniedInfo = await lstat(deniedPath);
      assert(deniedInfo.isFile());
      assert.equal(deniedInfo.mode & 0o444, 0o444, "ACL fixture must allow read through ordinary mode bits");
      await access(binding.root, constants.R_OK | constants.X_OK);
    } else {
      await captureRoot(runtime);
      await preflightSource(binding);
      if (kind === "readonly") {
        const mount = mounts.trim().split("\n").map((line) => line.split(" "))
          .filter((fields) => runtime === fields[4] || runtime.startsWith(`${fields[4] === "/" ? "" : fields[4]}/`))
          .sort((a, b) => b[4].length - a[4].length)[0];
        assert(mount?.[5].split(",").includes("ro"), "VERIFICATION_BLOCKED: fixture must be on a real read-only mount");
      }
    }
    const expectedCodes = kind === "acl" ? ["EACCES"] : kind === "readonly" ? ["EROFS"] : ["EDQUOT", "ENOSPC"];
    // Checks backend diagnostics against native OS failures, rather than constructing
    // the diagnostic under test or accepting a successful operation under elevated access.
    const checkDiagnostic = (error) => {
      assert.equal(error.stage, kind === "acl" ? "source" : "runtime");
      assert.equal(error.code, kind === "acl" ? "source_unreadable" : "runtime_unwritable");
      assert(expectedCodes.includes(error.cause?.code), `Unexpected OS error: ${error.cause?.code}`);
      assert.equal(typeof error.path, "string");
      assert.equal(typeof error.retryable, "boolean");
      assert(error.guidance.length > 0);
      assert.equal(error.principal.uid, Number(credentials.Uid.split(/\s+/)[1]));
      assert.equal(error.principal.gid, Number(credentials.Gid.split(/\s+/)[1]));
      t.diagnostic(JSON.stringify({ kind, stage: error.stage, path: error.path, osCode: error.cause.code }));
      return true;
    };
    await assert.rejects(kind === "acl" ? preflightSource(binding) : prepareStorage(binding), checkDiagnostic);
    const f = await safetyFixture(t);
    await assert.rejects(f.lifecycle.add(binding.root), checkDiagnostic);
    assert.equal(f.starts(), 0);
    // Repeats a real OS operation after backend rejection. Any unexpected write is
    // confined to a uniquely owned NodeForge artifact, closed and cleaned before failure.
    const actualPath = kind === "acl" ? deniedPath : join(runtime, `.nodeforge-probe-${randomUUID()}`);
    let file;
    try {
      await assert.rejects(async () => {
        file = await open(actualPath, kind === "acl" ? "r" : "wx");
        if (kind !== "acl") { await file.writeFile("NodeForge environment verification\n"); await file.sync(); }
      }, (error) => {
        assert(expectedCodes.includes(error.code), `Unexpected actual-operation OS error: ${error.code}`);
        t.diagnostic(JSON.stringify({ kind, actualPath, osCode: error.code }));
        return true;
      });
    } finally {
      if (file) {
        await file.close();
        if (kind !== "acl") await unlink(actualPath);
      }
    }
    await assertRoot(binding);
    assert.deepEqual(await readFile(sourcePath), before);
    assert.deepEqual(await readdir(binding.root), entries);
    if (deniedInfo) {
      const after = await lstat(deniedPath);
      for (const key of ["dev", "ino", "size", "mtimeMs", "mode", "uid", "gid"]) assert.equal(after[key], deniedInfo[key]);
    }
  });
}
