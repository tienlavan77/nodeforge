// Business purpose: Verifies sandbox security, environment filtering, archive timeout/AbortSignal propagation, reconciliation edge cases, and role/path scope enforcement for `run_command` and the Forge Git Toolset.
// Technical description: Covers Reviewer round-2 regression requirements including indirect git blocking, inline child_process rejection, filtered env, timeout reconciliation, ledger error surfacing, symlink/ignored-dir/oversized-file tracking, deletion scope, SE/Coder mutation scope, missing-role rejection, and branch-create reconciliation.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildFilteredCommandEnv, createNodeCommandService } from "../../src/infrastructure/command/command-service.js";
import { createRunCommandTool } from "../../src/tools/roles/run-command-tool.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createGitWorkflowTools } from "../../src/tools/roles/git-workflow-tools.js";
import { snapshotWorkingTree, reconcileWorkingTreeMutation } from "../../src/infrastructure/git/workspace-ledger-sync.js";

const ALL_CAPS = ["run_command", "git_branch", "git_restore", "git_stash"];

// Business purpose: Initializes a temporary Git repository with an initial commit so sandbox and reconciliation tests operate in isolation without mutating the live workspace.
// Technical description: Creates a temporary directory via mkdtemp, initializes a Git repo on branch main, commits src/index.js, and returns the directory path.
async function makeIsolatedGitRepo() {
  const root = await mkdtemp(join(tmpdir(), "nf-command-git-sec-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.js"), "export const version = 1;\n");
  execFileSync("git", ["add", "src/index.js"], { cwd: root });
  execFileSync("git", ["-c", "user.name=NodeForge Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "feat: initial commit"], { cwd: root });
  return root;
}

test("Regression: blocks direct/indirect git execution, inline child_process spawning, and filters sensitive environment variables", async () => {
  const root = await makeIsolatedGitRepo();
  try {
    const cmdService = createNodeCommandService({ projectRoot: root });
    const runCommand = createRunCommandTool({ projectRoot: root, commandService: cmdService });
    const seCtx = { agent_identity: { agent_id: "se-1", role: "system_engineer" }, task_id: "TASK-SEC-1", capabilities: ALL_CAPS };

    for (const badInput of [
      { command: "git", args: ["status"] },
      { command: "pnpm", args: ["exec", "git", "status"] },
      { command: "npm", args: ["exec", "--", "git", "status"] },
      { command: "npx", args: ["git", "status"] },
      { command: "node", args: ["/usr/bin/git"] }
    ]) {
      await assert.rejects(() => runCommand.execute(badInput, seCtx), (err) => err.code === "COMMAND_GIT_FORBIDDEN");
    }

    for (const inlineBypass of [
      { command: "node", args: ["-e", "require('node:child_process').execSync('id')"] },
      { command: "node", args: ["--eval", "import('child_process').then(cp => cp.spawn('sh'))"] },
      { command: "node", args: ["-p", "process.binding('spawn_sync')"] },
      { command: "php", args: ["-r", "shell_exec('id');"] }
    ]) {
      await assert.rejects(() => runCommand.execute(inlineBypass, seCtx), (err) => err.code === "COMMAND_INLINE_PROCESS_FORBIDDEN");
    }

    const filteredEnv = buildFilteredCommandEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_AUTH_TOKEN: "tok-secret",
      DATABASE_URL: "postgres://secret",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret"
    });
    assert.equal(filteredEnv.PATH, "/usr/bin:/bin");
    assert.equal(filteredEnv.CI, "true");
    assert.equal(filteredEnv.OPENAI_API_KEY, undefined);
    assert.equal(filteredEnv.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(filteredEnv.DATABASE_URL, undefined);
    assert.equal(filteredEnv.GITHUB_TOKEN, undefined);
    assert.equal(filteredEnv.AWS_SECRET_ACCESS_KEY, undefined);

    process.env.TEST_LEAKED_SECRET_TOKEN = "should-not-leak";
    try {
      const envRes = await runCommand.execute(
        { command: "node", args: ["-e", "console.log(process.env.TEST_LEAKED_SECRET_TOKEN ?? 'FILTERED')"] },
        seCtx
      );
      assert.equal(envRes.stdout.trim(), "FILTERED");
    } finally {
      delete process.env.TEST_LEAKED_SECRET_TOKEN;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Regression: Archive service propagates caller timeout_ms and AbortSignal and blocks symlink/Zip Slip", async () => {
  const root = await makeIsolatedGitRepo();
  try {
    await symlink("/etc", join(root, "src", "escape-link"));
    const service = createNodeCommandService({ projectRoot: root });
    await assert.rejects(
      () => service.executeCommand({ command: "zip", args: ["-r", "src/out.zip", "src/escape-link"] }),
      (err) => err.code === "COMMAND_SYMLINK_ESCAPE"
    );

    await writeFile(join(root, "src", "dummy.zip"), "PK\x03\x04");
    const observedCalls = [];
    const customService = createNodeCommandService({
      projectRoot: root,
      async spawnProcess(cmd, args, opts) {
        observedCalls.push({ cmd, args, timeoutMs: opts.timeoutMs, hasSignal: Boolean(opts.signal) });
        if (args.includes("-Z1")) return { exitCode: 0, stdout: "../outside.txt\n", stderr: "", truncated: false };
        return { exitCode: 0, stdout: "", stderr: "", truncated: false };
      }
    });
    const controller = new AbortController();
    await assert.rejects(
      () => customService.executeCommand({ command: "unzip", args: ["-o", "src/dummy.zip", "-d", "src"], timeout_ms: 450 }, { signal: controller.signal }),
      (err) => err.code === "COMMAND_ZIP_SLIP_FORBIDDEN"
    );
    assert.equal(observedCalls.length, 1);
    assert.ok(observedCalls[0].timeoutMs <= 450);
    assert.equal(observedCalls[0].hasSignal, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Regression: reconciles timeout mutations, tracks symlinks/vendor/.forge/oversized files, surfaces ledger errors, and enforces deletion scope", async () => {
  const root = await makeIsolatedGitRepo();
  try {
    const before = await snapshotWorkingTree(root);
    await mkdir(join(root, "vendor"), { recursive: true });
    await writeFile(join(root, "vendor", "pkg.js"), "export const v = 1;\n");
    await symlink("index.js", join(root, "src", "link.js"));
    await writeFile(join(root, "src", "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 64, 0x61));

    const after = await snapshotWorkingTree(root);
    assert.ok(after.has("vendor/pkg.js"));
    assert.ok(after.has("src/link.js"));
    assert.ok(after.has("src/large.bin"));
    assert.equal(after.get("src/large.bin").oversized, true);

    const failingLedger = {
      async write() {
        throw new Error("LEDGER_DISK_FULL");
      }
    };
    await assert.rejects(
      () => reconcileWorkingTreeMutation({ projectRoot: root, beforeSnapshot: before, afterSnapshot: after, changeLedger: failingLedger }),
      /LEDGER_DISK_FULL/
    );

    await rm(join(root, "src", "large.bin"), { force: true });
    await rm(join(root, "src", "link.js"), { force: true });
    await rm(join(root, "vendor"), { recursive: true, force: true });

    await writeFile(
      join(root, "src", "write-then-hang.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('src/partial-timeout.js', 'export const p = 1;\\n'); setTimeout(() => {}, 10000);\n"
    );
    const runCommand = createRunCommandTool({ projectRoot: root });
    const timeoutCtx = {
      agent_identity: { agent_id: "se-1", role: "system_engineer" },
      task_id: "TASK-SEC-2",
      capabilities: ALL_CAPS,
      changed_paths: [],
      observed_files: []
    };
    await assert.rejects(
      () => runCommand.execute({ command: "node", args: ["src/write-then-hang.mjs"], timeout_ms: 150 }, timeoutCtx),
      (err) => err.code === "COMMAND_TIMEOUT" && err.changed_paths.includes("src/partial-timeout.js")
    );
    assert.ok(timeoutCtx.changed_paths.includes("src/partial-timeout.js"));

    await writeFile(join(root, "outside.txt"), "keep me\n");
    await writeFile(join(root, "src", "del-outside.mjs"), "import { unlinkSync } from 'node:fs'; unlinkSync('outside.txt');\n");
    const coderCtx = {
      agent_identity: { agent_id: "c-1", role: "coder" },
      task_id: "TASK-SEC-3",
      capabilities: ALL_CAPS,
      allowed_prefixes: ["src"]
    };
    await assert.rejects(
      () => runCommand.execute({ command: "node", args: ["src/del-outside.mjs"] }, coderCtx),
      (err) => err.code === "TOOL_RESOURCE_FORBIDDEN"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Regression: Git workflow tools fail closed on missing roles, reject .git/.forge paths, enforce SE and Coder scope, and reconcile branch create", async () => {
  const root = await makeIsolatedGitRepo();
  try {
    const gitService = createGitService({ projectRoot: root, mutationLock: (fn) => fn() });
    const workflow = createGitWorkflowTools({ gitService, projectRoot: root });
    const runCommand = createRunCommandTool({ projectRoot: root });
    const noRoleCtx = { task_id: "TASK-NOROLE", capabilities: ALL_CAPS };

    await assert.rejects(() => runCommand.execute({ command: "node", args: ["--version"] }, noRoleCtx), (err) => err.code === "TOOL_FORBIDDEN");
    await assert.rejects(() => workflow.git_branch.execute({ action: "create", name: "feat/no-role" }, noRoleCtx), (err) => err.code === "TOOL_FORBIDDEN");
    await assert.rejects(() => workflow.git_restore.execute({ action: "restore_worktree", paths: ["src/index.js"] }, noRoleCtx), (err) => err.code === "TOOL_FORBIDDEN");
    await assert.rejects(() => workflow.git_stash.execute({ action: "push" }, noRoleCtx), (err) => err.code === "TOOL_FORBIDDEN");

    const seScopedCtx = {
      agent_identity: { agent_id: "se-1", role: "system_engineer" },
      task_id: "TASK-SE-SCOPE",
      capabilities: ALL_CAPS,
      allowed_prefixes: ["src"],
      changed_paths: [],
      observed_files: []
    };
    await assert.rejects(
      () => workflow.git_restore.execute({ action: "restore_worktree", paths: [".git/config"] }, seScopedCtx),
      (err) => err.code === "GIT_PROTECTED_PATH"
    );
    await assert.rejects(
      () => workflow.git_stash.execute({ action: "push", paths: [".forge/state.json"] }, seScopedCtx),
      (err) => err.code === "GIT_PROTECTED_PATH"
    );
    await assert.rejects(
      () => workflow.git_restore.execute({ action: "restore_worktree", paths: ["docs/readme.md"] }, seScopedCtx),
      (err) => err.code === "TOOL_RESOURCE_FORBIDDEN"
    );

    const createRes = await workflow.git_branch.execute({ action: "create", name: "feat/reconciled" }, seScopedCtx);
    assert.equal(createRes.branch, "feat/reconciled");
    assert.ok(Array.isArray(createRes.changed_paths));
    assert.equal(typeof createRes.active_file_checksums, "object");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
