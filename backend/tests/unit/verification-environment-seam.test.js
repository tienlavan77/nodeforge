// Business purpose: verifies the Multi-Project Execution Environment Seam (Part 2) so all verification commands route through project-scoped adapters with strict path containment and deterministic runner cleanup.
// Technical description: exercises DEFAULT_DEPENDENCY_ROOTS, resolveProjectDependencyRoots, assertVerificationExecutionScope, executeWithVerificationEnvironmentSeam across filesystem_namespace, browser_fixture, and project_sandbox adapters, concurrent sibling project isolation, and closeVerificationEnvironmentSeam.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeTicketVerificationCommand } from "../../src/modules/supervisor/ticket/ticket-verification-command.js";
import {
  assertVerificationExecutionScope,
  closeVerificationEnvironmentSeam,
  DEFAULT_DEPENDENCY_ROOTS,
  executeWithVerificationEnvironmentSeam,
  resolveProjectDependencyRoots
} from "../../src/modules/supervisor/verification-environment-seam.js";

// Business purpose: creates two sibling project roots (Project A and Project B) under a shared parent directory to test cross-project boundary enforcement.
// Technical description: allocates a temporary parent directory with project-a and project-b subdirectories and registers test cleanup.
async function createSiblingProjectsFixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "nf-seam-siblings-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectA = join(parent, "project-a");
  const projectB = join(parent, "project-b");
  const archiveA = join(projectA, ".forge/runtime/ticket-verification/archives/archive-1");
  const tempA = join(archiveA, ".forge-tmp");
  const archiveB = join(projectB, ".forge/runtime/ticket-verification/archives/archive-1");
  const tempB = join(archiveB, ".forge-tmp");
  await mkdir(tempA, { recursive: true });
  await mkdir(tempB, { recursive: true });
  return { parent, projectA, projectB, archiveA, tempA, archiveB, tempB };
}

test("resolveProjectDependencyRoots returns canonical dependency roots for NodeForge and target projects", () => {
  const roots = resolveProjectDependencyRoots("/any/project");
  assert.deepEqual(roots, ["node_modules", "backend/node_modules", "ui/nextjs/node_modules"]);
  assert.equal(roots, DEFAULT_DEPENDENCY_ROOTS);
  assert.equal(Object.isFrozen(roots), true);
});

test("assertVerificationExecutionScope enforces canonical project containment for cwd and tempDir", async (t) => {
  const { projectA, projectB, archiveA, tempA, tempB } = await createSiblingProjectsFixture(t);

  const valid = await assertVerificationExecutionScope({
    projectRoot: projectA,
    cwd: archiveA,
    tempDir: tempA
  });
  assert.ok(valid.canonicalProjectRoot.endsWith("project-a"));
  assert.ok(valid.canonicalCwd.endsWith("archive-1"));
  assert.ok(valid.canonicalTempDir.endsWith(".forge-tmp"));

  // Rejects cwd belonging to sibling Project B.
  await assert.rejects(
    assertVerificationExecutionScope({ projectRoot: projectA, cwd: projectB, tempDir: tempA }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );

  // Rejects tempDir belonging to sibling Project B.
  await assert.rejects(
    assertVerificationExecutionScope({ projectRoot: projectA, cwd: archiveA, tempDir: tempB }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );

  // Rejects tempDir pointing directly to the root .forge directory.
  await assert.rejects(
    assertVerificationExecutionScope({ projectRoot: projectA, cwd: archiveA, tempDir: join(projectA, ".forge") }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );

  // Rejects symlinked tempDir escaping to Project B.
  const symlinkTemp = join(archiveA, "escaped-tmp");
  await symlink(tempB, symlinkTemp);
  await assert.rejects(
    assertVerificationExecutionScope({ projectRoot: projectA, cwd: archiveA, tempDir: symlinkTemp }),
    { code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION" }
  );
});

test("executeWithVerificationEnvironmentSeam routes browser_fixture, project_sandbox, and rejects invalid filesystem_namespace commands", async (t) => {
  const { projectA, archiveA, tempA } = await createSiblingProjectsFixture(t);

  // 1. project_sandbox adapter
  const projectRes = await executeTicketVerificationCommand({
    projectRoot: projectA,
    cwd: archiveA,
    tempDir: tempA,
    environment: "project",
    timeoutMs: 10000,
    argv: [process.execPath, "-e", "process.stdout.write(process.env.TMPDIR || '')"]
  });
  assert.equal(projectRes.exit_code, 0);
  assert.equal(projectRes.runtime_environment.type, "project_sandbox");
  assert.ok(projectRes.stdout.endsWith(".forge-tmp"));

  // 2. browser_fixture adapter
  const fakeBrowserScript = join(archiveA, "verify-ticket-browser.mjs");
  await writeFile(fakeBrowserScript, "process.stdout.write('BROWSER-OK');\n");
  const browserRes = await executeWithVerificationEnvironmentSeam({
    projectRoot: projectA,
    cwd: archiveA,
    tempDir: tempA,
    timeoutMs: 10000,
    argv: [process.execPath, fakeBrowserScript]
  });
  assert.equal(browserRes.exit_code, 0);
  assert.equal(browserRes.runtime_environment.type, "browser_fixture");

  // 3. filesystem_namespace rejects non-Node command before touching runner
  await assert.rejects(
    executeWithVerificationEnvironmentSeam({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      environment: "filesystem_namespace",
      argv: ["/bin/sh", "-c", "echo no"]
    }),
    { code: "VERIFY_ENVIRONMENT_INVALID" }
  );
});

test("concurrent Project A and Project B executions remain isolated and closeVerificationEnvironmentSeam cleans up cleanly", async (t) => {
  const { projectA, projectB, archiveA, tempA, archiveB, tempB } = await createSiblingProjectsFixture(t);

  const [resA, resB] = await Promise.all([
    executeTicketVerificationCommand({
      projectRoot: projectA,
      cwd: archiveA,
      tempDir: tempA,
      environment: "project",
      timeoutMs: 10000,
      argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), tmp: process.env.TMPDIR }))"]
    }),
    executeTicketVerificationCommand({
      projectRoot: projectB,
      cwd: archiveB,
      tempDir: tempB,
      environment: "project",
      timeoutMs: 10000,
      argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), tmp: process.env.TMPDIR }))"]
    })
  ]);

  assert.equal(resA.exit_code, 0);
  assert.equal(resB.exit_code, 0);
  const outA = JSON.parse(resA.stdout);
  const outB = JSON.parse(resB.stdout);
  assert.NotEqual?.(outA.cwd, outB.cwd);
  assert.notEqual(outA.cwd, outB.cwd);
  assert.notEqual(outA.tmp, outB.tmp);
  assert.ok(outA.cwd.includes("project-a"));
  assert.ok(outB.cwd.includes("project-b"));

  await closeVerificationEnvironmentSeam(projectA);
  await closeVerificationEnvironmentSeam(projectB);
});
