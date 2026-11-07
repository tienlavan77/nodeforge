// Business purpose: Verifies end-to-end execution, ledger/checksum reconciliation, Git workflow integration, and lookup_schema contract resolution for `run_command` and the Forge Git Toolset.
// Technical description: Tests O1, O2, and O3 core capabilities in isolated temporary Git repositories while keeping the test file well under the 250-line budget.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactCommandOutput } from "../../src/infrastructure/command/command-service.js";
import { createRunCommandTool } from "../../src/tools/roles/run-command-tool.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createGitReadTools } from "../../src/tools/discovery/git-read-tools.js";
import { createGitWorkflowTools } from "../../src/tools/roles/git-workflow-tools.js";
import { createLookupSchemaTool } from "../../src/tools/discovery/lookup-schema-tool.js";
import { ownerRoleTools, authorizeOwnerTool } from "../../src/tools/roles/owner-role-tool-policy.js";
import { READ_ONLY_EXPLORER_TOOLS } from "../../src/tools/discovery/delegate-subagent-tool.js";
import { checkpointedRegistry, createResumeState } from "../../src/modules/supervisor/ticket/ticket-resume.js";
import { activeFileChecksums } from "../../src/modules/supervisor/ticket/ticket-read-cache.js";

const ALL_CAPS = [
  "run_command", "git_status", "git_diff", "git_log", "git_show", "git_blame",
  "git_branch", "git_restore", "git_stash", "lookup_schema"
];

// Business purpose: Initializes a temporary Git repository with an initial commit so Git and command tests operate in isolation.
// Technical description: Creates a temp directory, runs git init and initial commit, and returns the root path.
async function createIsolatedGitRepo() {
  const root = await mkdtemp(join(tmpdir(), "nf-command-git-suite-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.js"), "export const version = 1;\n");
  execFileSync("git", ["add", "src/index.js"], { cwd: root });
  execFileSync("git", ["-c", "user.name=NodeForge Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "feat: initial commit"], { cwd: root });
  return root;
}

test("O1: run_command executes node, redacts secrets, bounds output to 8KB, and reconciles changed_paths + sha256 checksums", async () => {
  const root = await createIsolatedGitRepo();
  try {
    const ledgerWrites = [];
    const changeLedger = {
      async write(entry) {
        ledgerWrites.push(entry);
      }
    };
    const convStoreMap = new Map([["CONV-SE-1", { owner_changed_paths: [], active_file_checksums: {} }]]);
    const conversationStateStore = {
      async get(id) { return convStoreMap.get(id); },
      async update(id, patch) {
        const next = { ...(convStoreMap.get(id) ?? {}), ...patch };
        convStoreMap.set(id, next);
        return next;
      }
    };

    const runCommand = createRunCommandTool({
      projectRoot: root,
      changeLedger,
      conversationStateStore,
      conversationId: "CONV-SE-1"
    });

    const context = {
      agent_identity: { agent_id: "se-1", role: "system_engineer" },
      task_id: "TASK-SE-1",
      capabilities: ALL_CAPS,
      changed_paths: [],
      observed_files: []
    };

    await writeFile(
      join(root, "src", "write-gen.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('src/generated.js', 'export const generated = true;\\n'); console.log('API_KEY=supersecret123456 Bearer eyJhbGciOiJIUzI1NiJ9.secret');\n"
    );

    const res = await runCommand.execute(
      { command: "node", args: ["src/write-gen.mjs"] },
      context
    );

    assert.equal(res.exit_code, 0);
    assert.match(res.stdout, /API_KEY=\[REDACTED\]/);
    assert.match(res.stdout, /Bearer \[REDACTED\]/);
    assert.ok(!res.stdout.includes("supersecret123456"));
    assert.ok(res.changed_paths.includes("src/generated.js"));
    assert.match(res.active_file_checksums["src/generated.js"], /^sha256:[0-9a-f]{64}$/);
    assert.ok(ledgerWrites.some((item) => item.path === "src/generated.js"));
    assert.match(convStoreMap.get("CONV-SE-1").active_file_checksums["src/generated.js"].sha256, /^sha256:[0-9a-f]{64}$/);

    const huge = redactCommandOutput("x".repeat(20_000), 8 * 1024);
    assert.equal(huge.truncated, true);
    assert.ok(Buffer.byteLength(huge.text, "utf8") <= 8 * 1024 + 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O2: Complete Forge Git Toolset (status, diff, log, show, blame, branch, restore, stash) works with protected branches and ledger reconciliation", async () => {
  const root = await createIsolatedGitRepo();
  try {
    let lockChain = Promise.resolve();
    // Business purpose: Serializes Git mutations during unit tests.
    // Technical description: Chains promises to mimic project mutationLock.
    const mutationLock = (fn) => {
      const next = lockChain.then(fn, fn);
      lockChain = next.catch(() => {});
      return next;
    };
    const gitService = createGitService({ projectRoot: root, mutationLock });
    const readTools = createGitReadTools({ gitService });
    const workflowTools = createGitWorkflowTools({ gitService, projectRoot: root });
    const seContext = { agent_identity: { agent_id: "se-1", role: "system_engineer" }, task_id: "TASK-SE-2", capabilities: ALL_CAPS, changed_paths: [], observed_files: [] };
    const rvContext = { agent_identity: { agent_id: "rv-1", role: "reviewer" }, task_id: "TASK-RV-1", capabilities: ALL_CAPS };

    await writeFile(join(root, "src", "index.js"), "export const version = 2;\nexport const extra = 'ok';\n");

    const statusRes = await readTools.git_status.execute({ paths: ["src"] }, rvContext);
    assert.equal(statusRes.branch, "main");
    assert.equal(statusRes.clean, false);
    assert.equal(statusRes.modified_count, 1);

    const diffStat = await readTools.git_diff.execute({ paths: ["src/index.js"], stat_only: true, unified: 1 }, rvContext);
    assert.match(diffStat.stdout, /src\/index\.js/);

    const logRes = await readTools.git_log.execute({ limit: 5, path: "src/index.js" }, rvContext);
    assert.equal(logRes.commits.length, 1);
    assert.equal(logRes.commits[0].subject, "feat: initial commit");

    const showFile = await readTools.git_show.execute({ revision: "HEAD", path: "src/index.js" }, rvContext);
    assert.equal(showFile.content, "export const version = 1;\n");
    assert.match(showFile.sha256, /^sha256:[0-9a-f]{64}$/);

    const blameRes = await readTools.git_blame.execute({ path: "src/index.js", start_line: 1, end_line: 1 }, rvContext);
    assert.equal(blameRes.lines.length, 1);
    assert.equal(blameRes.lines[0].content, "export const version = 2;");

    const branchList = await workflowTools.git_branch.execute({ action: "list" }, rvContext);
    assert.equal(branchList.current, "main");
    await assert.rejects(() => workflowTools.git_branch.execute({ action: "create", name: "feat/rv" }, rvContext), (err) => err.code === "TOOL_FORBIDDEN");
    await assert.rejects(() => workflowTools.git_branch.execute({ action: "create", name: "main" }, seContext), (err) => err.code === "GIT_PROTECTED_BRANCH");

    const createdBranch = await workflowTools.git_branch.execute({ action: "create", name: "feat/test-branch" }, seContext);
    assert.equal(createdBranch.branch, "feat/test-branch");
    assert.ok(Array.isArray(createdBranch.changed_paths));
    assert.equal(typeof createdBranch.active_file_checksums, "object");

    const stashPush = await workflowTools.git_stash.execute({ action: "push", message: "wip index", paths: ["src/index.js"] }, seContext);
    assert.equal(stashPush.action, "push");
    assert.ok(stashPush.changed_paths.includes("src/index.js"));

    const stashPop = await workflowTools.git_stash.execute({ action: "pop", index: 0 }, seContext);
    assert.equal(stashPop.action, "pop");
    assert.match(stashPop.active_file_checksums["src/index.js"], /^sha256:[0-9a-f]{64}$/);

    const restored = await workflowTools.git_restore.execute({ action: "restore_worktree", paths: ["src/index.js"] }, seContext);
    assert.deepEqual(restored.restored_paths, ["src/index.js"]);
    assert.match(restored.active_file_checksums["src/index.js"], /^sha256:[0-9a-f]{64}$/);

    await workflowTools.git_branch.execute({ action: "switch", name: "main" }, seContext);
    const delBranch = await workflowTools.git_branch.execute({ action: "delete_merged", name: "feat/test-branch" }, seContext);
    assert.equal(delBranch.deleted, true);

    assert.equal(READ_ONLY_EXPLORER_TOOLS.includes("git_log"), true);
    assert.equal(READ_ONLY_EXPLORER_TOOLS.includes("run_command"), false);
    assert.equal(ownerRoleTools("architecture_manager").includes("git_branch"), true);
    assert.equal(ownerRoleTools("architecture_manager").includes("run_command"), false);
    const amContext = { agent_identity: { agent_id: "am-1", role: "architecture_manager" }, task_id: "TASK-AM-1", capabilities: ALL_CAPS };
    await authorizeOwnerTool("git_branch", { action: "list" }, amContext, root);
    await assert.rejects(() => authorizeOwnerTool("git_branch", { action: "create", name: "x" }, amContext, root), (err) => err.code === "TOOL_FORBIDDEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O1 & O2: Ticket Runtime checkpointedRegistry reconciles state.readCache and changedPaths after run_command", async () => {
  const root = await createIsolatedGitRepo();
  try {
    const runCommand = createRunCommandTool({ projectRoot: root });
    const state = createResumeState(null);
    const store = { async save() {}, async complete() {} };
    const wrapped = checkpointedRegistry({
      store,
      registry: { run_command: runCommand },
      taskId: "TKT-1",
      selected: { agent_id: "coder-1", role: "coder" },
      resumeState: state
    });
    await writeFile(join(root, "src", "gen-step.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('src/from-cmd.js', 'export const x = 42;\\n');\n");
    const res = await wrapped.run_command.execute(
      { command: "node", args: ["src/gen-step.mjs"] },
      { agent_identity: { agent_id: "coder-1", role: "coder" }, task_id: "TKT-1", capabilities: ALL_CAPS, project_root: root, changed_paths: [] }
    );
    assert.equal(res.exit_code, 0);
    assert.ok(state.changedPaths.includes("src/from-cmd.js"));
    const checksums = activeFileChecksums(state.readCache);
    assert.match(checksums["src/from-cmd.js"].sha256, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O3: lookup_schema resolves forge.run_command.v1 and forge.git_tools.v1 with action filtering and role permissions", async () => {
  const seLookup = createLookupSchemaTool();
  const seCtx = { agent_identity: { agent_id: "se-1", role: "system_engineer" }, task_id: "TASK-SCHEMA-1", capabilities: ALL_CAPS };
  const rvCtx = { agent_identity: { agent_id: "rv-1", role: "reviewer" }, task_id: "TASK-SCHEMA-2", capabilities: ALL_CAPS };

  const catalog = await seLookup.execute({}, seCtx);
  assert.ok(catalog.matches.some((s) => s.schema_id === "forge.run_command.v1"));
  assert.ok(catalog.matches.some((s) => s.schema_id === "forge.git_tools.v1"));

  const fullRunCmd = await seLookup.execute({ schema_id: "forge.run_command.v1" }, seCtx);
  assert.deepEqual(fullRunCmd.schema["x-role-permissions"].allowed_roles, ["system_engineer", "coder"]);
  assert.ok(fullRunCmd.schema["x-role-permissions"].forbidden_roles.includes("reviewer"));

  const pnpmContract = await seLookup.execute({ schema_id: "forge.run_command.v1", action: "pnpm" }, seCtx);
  assert.equal(pnpmContract.schema.oneOf.length, 1);
  assert.equal(pnpmContract.schema.oneOf[0].title, "pnpm");

  const gitDiffContract = await seLookup.execute({ schema_id: "forge.git_tools.v1", action: "git_diff" }, rvCtx);
  assert.equal(gitDiffContract.schema.oneOf.length, 1);
  assert.equal(gitDiffContract.schema.oneOf[0].title, "git_diff");
  assert.ok(gitDiffContract.schema["x-role-permissions"].read_only_tools.allowed_roles.includes("subagent"));

  const validateOut = execFileSync(process.execPath, ["backend/scripts/validate-schemas.mjs"], { encoding: "utf8" });
  assert.match(validateOut, /Validated \d+ schemas/);
});
