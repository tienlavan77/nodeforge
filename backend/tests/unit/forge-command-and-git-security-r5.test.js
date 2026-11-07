// Business purpose: Verifies round-4 and round-5 security and governance regressions across inline command sandboxes, --option=value path containment, run_command out-of-scope reconciliation, git_stash rename preflight, commit-bound run_check fail-closed metadata, and role README schema contracts.
// Technical description: Tests createNodeCommandService, createRunCommandTool, createGitWorkflowTools, createOwnerEngineerTools, createGitService, and role README documents in isolated temporary Git repositories.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { createNodeCommandService } from "../../src/infrastructure/command/command-service.js";
import { createRunCommandTool } from "../../src/tools/roles/run-command-tool.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createGitWorkflowTools } from "../../src/tools/roles/git-workflow-tools.js";
import { createOwnerEngineerTools } from "../../src/tools/roles/owner-engineer-tools.js";

const ALL_CAPS = ["run_command", "git_branch", "git_restore", "git_stash"];

// Business purpose: Initializes a temporary Git repository with an initial commit so sandbox and reconciliation tests operate in isolation without mutating the live workspace.
// Technical description: Creates a temporary directory via mkdtemp, initializes a Git repo on branch main, commits src/index.js, and returns the directory path.
async function makeIsolatedGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), "nf-sec-r5-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "forge@example.com"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.js"), "export const x = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("Regression Round-4 & Round-5: inline evaluation projectRoot sandbox, --option=value path containment, and non-ENOENT symlink failure", async () => {
  const root = await makeIsolatedGitRepo();
  const outsideFile = join(tmpdir(), `nf-escape-${Date.now()}.txt`);
  try {
    const cmdService = createNodeCommandService({ projectRoot: root });

    // 1. Inline php -r and node -e escaping projectRoot are rejected by policy or sandbox
    await assert.rejects(
      () => cmdService.executeCommand({ command: "php", args: ["-r", `file_put_contents('${outsideFile}', 'x');`] }),
      (err) => err.code === "COMMAND_PATH_OUTSIDE_PROJECT"
    );
    await assert.rejects(
      () => cmdService.executeCommand({ command: "node", args: ["-e", `require('node:fs').writeFileSync('${outsideFile}', 'x')`] }),
      (err) => err.code === "COMMAND_PATH_OUTSIDE_PROJECT"
    );
    await assert.rejects(
      () => cmdService.executeCommand({ command: "node", args: ["-e", "require('node:fs').readFileSync('../outside.txt')"] }),
      (err) => err.code === "COMMAND_PATH_OUTSIDE_PROJECT"
    );

    // Runtime sandbox enforcement even for obfuscated dynamic paths inside node -e
    const obfuscatedRes = await cmdService.executeCommand({
      command: "node",
      args: ["-e", "const p = ['', 'tmp', 'nf-sandbox-probe.txt'].join('/'); require('node:fs').writeFileSync(p, 'x');"]
    });
    assert.notEqual(obfuscatedRes.exit_code, 0);

    // 2. Round-5 Blocker: --option=value path forms (npm --prefix=/tmp, pnpm --dir=/tmp, php -c=/tmp) are validated against projectRoot
    for (const badOptionCall of [
      { command: "npm", args: ["--prefix=/tmp", "test"] },
      { command: "npm", args: ["--prefix=../outside", "test"] },
      { command: "pnpm", args: ["--dir=/tmp", "test"] },
      { command: "pnpm", args: ["-C=/tmp", "test"] },
      { command: "php", args: ["-c=/tmp/php.ini", "-v"] },
      { command: "php", args: ["-c/tmp/php.ini", "-v"] },
      { command: "unzip", args: ["-d=/tmp", "src/archive.zip"] }
    ]) {
      await assert.rejects(
        () => cmdService.executeCommand(badOptionCall),
        (err) => err.code === "COMMAND_PATH_OUTSIDE_PROJECT",
        `Expected COMMAND_PATH_OUTSIDE_PROJECT for ${badOptionCall.command} ${badOptionCall.args.join(" ")}`
      );
    }

    // Symlink escape via --option=value inside projectRoot
    await symlink("/tmp", join(root, "src", "escape-dir-link"));
    await assert.rejects(
      () => cmdService.executeCommand({ command: "pnpm", args: ["--dir=src/escape-dir-link", "test"] }),
      (err) => err.code === "COMMAND_SYMLINK_ESCAPE"
    );

    // 3. assertNoSymlinkEscape fails closed on non-ENOENT filesystem errors (e.g. ENOTDIR when parent segment is a regular file)
    await assert.rejects(
      () => cmdService.executeCommand({ command: "node", args: ["src/index.js/nested-child.js"] }),
      (err) => err.code === "COMMAND_FILESYSTEM_ERROR"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideFile, { force: true });
  }
});

test("Regression Round-5: out-of-scope run_command reconciles observed delta with ledger suppressed, and scoped git_stash push validates rename sources", async () => {
  const root = await makeIsolatedGitRepo();
  try {
    const ledgerWrites = [];
    const stateMap = new Map();
    const stateStore = {
      get: async (id) => stateMap.get(id) ?? {},
      update: async (id, patch) => stateMap.set(id, { ...(stateMap.get(id) ?? {}), ...patch })
    };
    const runCommandTool = createRunCommandTool({
      projectRoot: root,
      changeLedger: { write: async (entry) => ledgerWrites.push(entry) },
      conversationStateStore: stateStore,
      conversationId: "CONV-R5-CMD"
    });
    const scopedCoderCtx = {
      agent_identity: { agent_id: "coder-r5", role: "coder" },
      task_id: "TASK-R5",
      conversation_id: "CONV-R5-CMD",
      capabilities: ALL_CAPS,
      allowed_prefixes: ["src"],
      changed_paths: [],
      observed_files: []
    };
    await mkdir(join(root, "docs"), { recursive: true });
    await assert.rejects(
      () => runCommandTool.execute({
        command: "node",
        args: ["-e", "require('node:fs').writeFileSync('docs/unauthorized.md', '# out of scope\\n')"]
      }, scopedCoderCtx),
      (err) => err.code === "TOOL_RESOURCE_FORBIDDEN"
        && Array.isArray(err.changed_paths)
        && err.changed_paths.includes("docs/unauthorized.md")
        && Boolean(err.active_file_checksums?.["docs/unauthorized.md"])
    );
    assert.equal(ledgerWrites.length, 0, "changeLedger must not record unauthorized mutations");
    assert.ok(scopedCoderCtx.changed_paths.includes("docs/unauthorized.md"));
    assert.ok(stateMap.get("CONV-R5-CMD")?.active_file_checksums?.["docs/unauthorized.md"]);

    // Scoped git_stash push validates BOTH rename source and destination when status reports `R  old -> new`
    let stashedPayload = null;
    const renameGitService = {
      status: async () => "R  docs/old-spec.md -> src/new-spec.md\n",
      stash: async (payload) => { stashedPayload = payload; return { action: "push", paths: payload.paths }; }
    };
    const workflow = createGitWorkflowTools({ gitService: renameGitService, projectRoot: root });
    await assert.rejects(
      () => workflow.git_stash.execute({ action: "push", message: "rename stash" }, scopedCoderCtx),
      (err) => err.code === "TOOL_RESOURCE_FORBIDDEN"
    );
    assert.equal(stashedPayload, null, "stash must not execute when rename source is outside scope");

    // When both rename source and destination are inside scope, explicit validated paths are passed to gitService.stash
    const inScopeRenameGit = {
      status: async () => "R  src/index.js -> src/renamed.js\n",
      stash: async (payload) => { stashedPayload = payload; return { action: "push", paths: payload.paths, output: "Saved" }; }
    };
    const inScopeWorkflow = createGitWorkflowTools({ gitService: inScopeRenameGit, projectRoot: root });
    const stashRes = await inScopeWorkflow.git_stash.execute({ action: "push", message: "valid rename" }, scopedCoderCtx);
    assert.deepEqual(stashRes.paths, ["src/index.js", "src/renamed.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Regression Round-4 & Round-5: commit-bound run_check fail-closed metadata, inspectStatus branch failure propagation, and role README schema lookup tables", async () => {
  const root = await makeIsolatedGitRepo();
  try {
    const loggedEvents = [];
    const brokenHeadTools = createOwnerEngineerTools({
      testService: { runCheck: async () => ({ status: "passed", ready_for_review: true }) },
      gitService: {
        getHead: async () => { throw new Error("git rev-parse HEAD failed"); },
        getCommitParent: async () => "b".repeat(40)
      },
      logger: { emit: (ev) => loggedEvents.push(ev) }
    });
    await assert.rejects(
      () => brokenHeadTools.implementations.run_check.execute({ type: "test", command: "node --test backend/tests/unit/lookup-schema-tool.test.js" }, { conversation_id: "CONV-CHK" }),
      (err) => err.code === "GIT_METADATA_UNAVAILABLE"
    );
    assert.ok(loggedEvents.some((ev) => ev.event_name === "forge.run_check_git_metadata_failed"));

    const gitEvents = [];
    const brokenBranchGit = createGitService({
      projectRoot: root,
      onEvent: (ev) => gitEvents.push(ev),
      runGit: async (args) => {
        if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "branch" && args[1] === "--show-current") {
          return { exitCode: 128, stdout: "", stderr: "fatal: corrupt ref" };
        }
        return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      }
    });
    await assert.rejects(
      () => brokenBranchGit.inspectStatus(),
      (err) => err.code === "GIT_BRANCH_FAILED"
    );
    assert.ok(gitEvents.some((ev) => ev.type === "git.status.branch_lookup_failed"));

    // Verify O3 role README contracts contain forge.git_tools.v1 and forge.run_command.v1
    const repoRoot = resolve(import.meta.dirname, "../../..");
    for (const [readmeRel, requiredSchemas] of [
      ["workflows/agents/system-engineer/README.md", ["forge.run_command.v1", "forge.git_tools.v1"]],
      ["workflows/agents/coder/README.md", ["forge.run_command.v1", "forge.git_tools.v1"]],
      ["workflows/agents/architecture/README.md", ["forge.git_tools.v1"]],
      ["workflows/agents/sprint-leader/README.md", ["forge.git_tools.v1"]],
      ["workflows/agents/reviewer/README.md", ["forge.git_tools.v1"]]
    ]) {
      const content = await readFile(join(repoRoot, readmeRel), "utf8");
      for (const schemaId of requiredSchemas) {
        assert.ok(content.includes(schemaId), `Expected ${readmeRel} to document ${schemaId}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
