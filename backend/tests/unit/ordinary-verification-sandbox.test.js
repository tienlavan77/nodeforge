// Business purpose: verifies the Ordinary Verification Write Sandbox (Part 1) so ordinary verification commands fail closed when Bubblewrap is unavailable, mask sibling projects and .forge state, keep source read-only, and restrict writes to job-scoped temp, runtime, and output directories.
// Technical description: exercises buildOrdinaryVerificationSandboxPlan and runOrdinaryVerificationSandbox across missing binary fail-closed checks, mount plan invariants, symlink escape rejection, timeout/abort teardown, and concurrent sibling project isolation.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildOrdinaryVerificationSandboxPlan,
  runOrdinaryVerificationSandbox
} from "../../src/modules/supervisor/ordinary-verification-sandbox.js";
import { executeTicketVerificationCommand } from "../../src/modules/supervisor/ticket/ticket-verification-command.js";

// Business purpose: creates two sibling project roots with archive and temp directories for sandbox isolation tests.
// Technical description: allocates temporary directories for project-a, project-b, and a global catalog file.
async function createSandboxProjectsFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-ordinary-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogDir = join(root, "catalog");
  const projectA = join(root, "projects/project-a");
  const projectB = join(root, "projects/project-b");
  const archiveA = join(projectA, ".forge/runtime/ticket-verification/archives/job-a");
  const tempA = join(archiveA, ".forge-tmp");
  const outputA = join(archiveA, "coverage");
  const archiveB = join(projectB, ".forge/runtime/ticket-verification/archives/job-b");
  const tempB = join(archiveB, ".forge-tmp");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(tempA, { recursive: true });
  await mkdir(outputA, { recursive: true });
  await mkdir(tempB, { recursive: true });
  await writeFile(join(catalogDir, "projects.json"), '{"projects":[]}\n');
  await writeFile(join(projectA, "source.js"), "export const a = 1;\n");
  await writeFile(join(projectB, "secret.js"), "export const b = 2;\n");
  return { root, catalogDir, projectA, projectB, archiveA, tempA, outputA, archiveB, tempB };
}

test("Part 1: ordinary verification sandbox fails closed without calling host spawn when Bubblewrap binary is missing", async (t) => {
  const { projectA, archiveA, tempA } = await createSandboxProjectsFixture(t);
  let spawnCalled = false;
  await assert.rejects(
    executeTicketVerificationCommand({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      sandbox: true,
      bwrapPath: join(projectA, "nonexistent-bwrap"),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error("Host spawn must never be called when bwrap is missing");
      },
      argv: [process.execPath, "-e", "console.log('should not run')"]
    }),
    { code: "VERIFY_SANDBOX_UNAVAILABLE" }
  );
  assert.equal(spawnCalled, false);
});

test("Part 1: buildOrdinaryVerificationSandboxPlan binds source read-only, masks .forge and sibling parent root, and restricts writable mounts to temp/runtime/output", async (t) => {
  const { catalogDir, projectA, projectB, archiveA, tempA, outputA } = await createSandboxProjectsFixture(t);
  const plan = await buildOrdinaryVerificationSandboxPlan({
    projectRoot: projectA,
    cwd: archiveA,
    tempDir: tempA,
    outputDirs: ["coverage"],
    argv: [process.execPath, "--test", "backend/tests/example.test.js"],
    env: { ...process.env, NODEFORGE_PROJECT_CATALOG_PATH: join(catalogDir, "projects.json") }
  });

  const argsText = plan.args.join(" ");
  assert.ok(plan.args.includes("--die-with-parent"));
  assert.ok(plan.args.includes("--new-session"));
  assert.ok(plan.args.includes("--clearenv"));

  // Masks parent directory of sibling projects and catalog directory.
  assert.ok(argsText.includes(`--tmpfs ${ plan.canonicalProjectRoot.replace(/\/project-a$/, "") }`));
  assert.ok(argsText.includes(`--ro-bind ${plan.canonicalProjectRoot} ${plan.canonicalProjectRoot}`));
  // Masks the root .forge directory of Project A.
  assert.ok(argsText.includes(`--tmpfs ${join(plan.canonicalProjectRoot, ".forge")}`));
  // Mounts the archive itself read-only.
  assert.ok(argsText.includes(`--ro-bind ${plan.canonicalCwd} ${plan.canonicalCwd}`));
  // Mounts only tempDir, archive runtime, and declared outputDir writable.
  assert.ok(argsText.includes(`--bind ${plan.canonicalTempDir} ${plan.canonicalTempDir}`));
  assert.ok(argsText.includes(`--bind ${plan.canonicalTempDir} /tmp`));
  assert.ok(argsText.includes(`--bind ${join(plan.canonicalCwd, ".forge/runtime")} ${join(plan.canonicalCwd, ".forge/runtime")}`));
  assert.ok(argsText.includes(`--bind ${plan.canonicalOutputs[0]} ${plan.canonicalOutputs[0]}`));
  // Sibling Project B is never mounted into Project A's namespace.
  assert.ok(!argsText.includes(projectB));
  assert.ok(outputA.endsWith("coverage"));
});

test("Part 1: sandbox plan rejects symlink escape, traversal in outputDirs, and cross-project paths before execution", async (t) => {
  const { projectA, projectB, archiveA, tempA } = await createSandboxProjectsFixture(t);

  // 1. Cross-project cwd rejected
  await assert.rejects(
    buildOrdinaryVerificationSandboxPlan({
      projectRoot: projectA,
      cwd: projectB,
      tempDir: tempA,
      argv: [process.execPath, "-v"]
    }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );

  // 2. Parent traversal in outputDirs rejected
  await assert.rejects(
    buildOrdinaryVerificationSandboxPlan({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      outputDirs: ["../../outside"],
      argv: [process.execPath, "-v"]
    }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );

  // 3. Symlink escape in outputDirs rejected
  const escapedLink = join(archiveA, "symlink-out");
  await symlink(projectB, escapedLink);
  await assert.rejects(
    buildOrdinaryVerificationSandboxPlan({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      outputDirs: ["symlink-out"],
      argv: [process.execPath, "-v"]
    }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );
});

test("Part 1: runOrdinaryVerificationSandbox handles concurrent A/B runs, timeout, abort, and Bubblewrap mount failure cleanly", async (t) => {
  const { projectA, projectB, archiveA, tempA, archiveB, tempB } = await createSandboxProjectsFixture(t);

  // Helper fake spawn that simulates Bubblewrap execution deterministically.
  const createFakeBwrapSpawn = ({ delayMs = 5, exitCode = 0, stderrText = "", stdoutText = "SANDBOX-OK" } = {}) => {
    const invocations = [];
    const spawnImpl = (cmd, args, options) => {
      invocations.push({ cmd, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit("close", null, "SIGKILL"));
      };
      const timer = setTimeout(() => {
        if (child.killed) return;
        if (stdoutText) child.stdout.write(stdoutText);
        if (stderrText) child.stderr.write(stderrText);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode, null);
      }, delayMs);
      timer.unref?.();
      return child;
    };
    return { spawnImpl, invocations };
  };

  // 1. Concurrent Project A and Project B sandbox executions keep independent mounts and receipts.
  const fakeA = createFakeBwrapSpawn({ stdoutText: "A-PASS" });
  const fakeB = createFakeBwrapSpawn({ stdoutText: "B-PASS" });
  const [resA, resB] = await Promise.all([
    executeTicketVerificationCommand({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      sandbox: true,
      spawnImpl: fakeA.spawnImpl,
      argv: [process.execPath, "--test", "a.test.js"]
    }),
    executeTicketVerificationCommand({
      projectRoot: projectB,
      cwd: archiveB,
      tempDir: tempB,
      sandbox: true,
      spawnImpl: fakeB.spawnImpl,
      argv: [process.execPath, "--test", "b.test.js"]
    })
  ]);
  assert.equal(resA.exit_code, 0);
  assert.equal(resB.exit_code, 0);
  assert.equal(resA.runtime_environment.engine, "bwrap");
  assert.equal(resB.runtime_environment.engine, "bwrap");
  assert.notEqual(resA.runtime_environment.project_root, resB.runtime_environment.project_root);
  assert.notEqual(resA.runtime_environment.temp_dir, resB.runtime_environment.temp_dir);

  // 2. Bubblewrap mount/namespace setup failure rejects with VERIFY_SANDBOX_FAILED.
  const failedMount = createFakeBwrapSpawn({ exitCode: 1, stderrText: "bwrap: Can't mount /proc: Operation not permitted\n" });
  await assert.rejects(
    runOrdinaryVerificationSandbox({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      spawnImpl: failedMount.spawnImpl,
      argv: [process.execPath, "-v"]
    }),
    { code: "VERIFY_SANDBOX_FAILED" }
  );

  // 3. Timeout kills the sandbox process and returns exit_code: null, timed_out: true.
  const slowSandbox = createFakeBwrapSpawn({ delayMs: 500 });
  const timedOutRes = await runOrdinaryVerificationSandbox({
    projectRoot: projectA,
    cwd: archiveA,
    tempDir: tempA,
    timeoutMs: 20,
    spawnImpl: slowSandbox.spawnImpl,
    argv: [process.execPath, "-v"]
  });
  assert.equal(timedOutRes.exit_code, null);
  assert.equal(timedOutRes.timed_out, true);

  // 4. AbortSignal cancels the sandbox immediately.
  const controller = new AbortController();
  const abortSandbox = createFakeBwrapSpawn({ delayMs: 500 });
  const pending = runOrdinaryVerificationSandbox({
    projectRoot: projectA,
    cwd: archiveA,
    tempDir: tempA,
    signal: controller.signal,
    spawnImpl: abortSandbox.spawnImpl,
    argv: [process.execPath, "-v"]
  });
  setTimeout(() => controller.abort(Object.assign(new Error("Owner cancelled check"), { code: "VERIFY_ABORTED" })), 10);
  await assert.rejects(pending, { code: "VERIFY_ABORTED" });
});
