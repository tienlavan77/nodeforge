// Proves Node verification runs lint and unit tests for backend source inside an ignored ticket worktree.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createFileGraph } from "../../src/modules/index/file-graph.js";
import { createTicketWorkspaceService } from "../../src/modules/supervisor/ticket-workspace-service.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";

const execFile = promisify(execFileCallback);
const sourceRoot = resolve(".");

// Runs Git only inside the disposable fixture repository.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

// Reads the durable job instead of relying on a verification callback.
async function finished(service, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await service.getTestResult({ jobId });
    if (result.status !== "running") return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Backend verification job did not finish.");
}

// Catches ignored-worktree ESLint warnings and Node directory test targets with a real command plan.
test("backend ticket worktree verification executes named test files", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "nodeforge-verification-worktree-"));
  const root = join(temp, "project");
  let database;
  let workspaces;
  try {
    for (const directory of ["backend/src", "backend/tests/unit", "backend/scripts", "eslint-rules"]) await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
    await writeFile(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true }, include: ["backend/src/**/*.js"] }));
    await writeFile(join(root, "backend/src/witness.js"), "// Supplies a disposable backend value for ticket verification.\nexport const witness = 'before';\n");
    await writeFile(join(root, "backend/tests/unit/witness.test.js"), "// Checks that the disposable backend module can be loaded.\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { witness } from '../../src/witness.js';\ntest('witness value is text', () => assert.equal(typeof witness, 'string'));\n");
    await writeFile(join(root, "backend/scripts/validate-schemas.mjs"), "// Validates the disposable archive contract.\nprocess.stdout.write('schema fixture passed\\n');\n");
    for (const path of [".eslintrc.json", "eslint-rules/package.json", "eslint-rules/no-silent-catch.js"]) await writeFile(join(root, path), await readFile(join(sourceRoot, path)));
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Baseline");
    await symlink(join(sourceRoot, "node_modules"), join(root, "node_modules"), "dir");
    const files = createFileService({ projectRoot: root });
    database = await openIndexDatabase(root);
    workspaces = createTicketWorkspaceService({ projectRoot: root, projectId: "PROJECT-VERIFY-WORKTREE", stateFileService: files, protocolStorage: { get() {}, save() {} }, indexDatabase: database, codeSearch: createCodeSearch({ database }), fileGraph: createFileGraph({ database }) });
    const workspace = await workspaces.open("TICKET-VERIFY-WORKTREE");
    await prepareTicketExecutionContext({ workspace, taskId: "TICKET-VERIFY-WORKTREE", supervisorId: "SUP-VERIFY-WORKTREE" });
    const before = await files.readFile({ path: "backend/src/witness.js" });
    await workspace.changeLedger.write({ path: "backend/src/witness.js", before, after: before.replace("'before'", "'after'") });
    const coding = await workspace.executionContexts.syncManifest("TICKET-VERIFY-WORKTREE", await workspace.changeLedger.snapshot());
    const commit = await workspace.gitService.commit("Verify backend test plan", { paths: ["backend/src/witness.js"] });
    await workspace.executionContexts.update("TICKET-VERIFY-WORKTREE", coding.version, { state: "committed", review_commit_sha: commit.sha });
    const started = await workspace.testService.startTests();
    const result = await finished(workspace.testService, started.job_id);
    assert.equal(result.status, "passed", JSON.stringify(result.error ?? result.result));
    const artifact = await workspace.testService.assertPassedArtifact();
    assert.deepEqual(artifact.commands.map(({ kind, exit_code }) => [kind, exit_code]), [["typecheck", 0], ["lint", 0], ["schema_validation", 0], ["backend_tests", 0]]);
    assert.ok(artifact.commands[3].argv.some((item) => item.endsWith("backend/tests/unit/witness.test.js")));
    assert.equal(artifact.policy_version, "ticket-verification-v4");
    assert.equal(artifact.commands.every((command) => /^sha256:[a-f0-9]{64}$/.test(command.output_sha256)), true);
    assert.ok(artifact.commit_sha && artifact.base_sha && artifact.source_revision && artifact.manifest_sha);
  } finally {
    await workspaces?.close();
    await database?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
