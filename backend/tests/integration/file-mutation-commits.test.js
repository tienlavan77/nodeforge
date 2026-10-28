// Verifies end-to-end Git staging and commit creation for file deletions and moves across
// TicketRootCommitService (TicketRootGit), TicketCommitService, and System Engineer commit_changes
// so deleted and relocated paths are accurately committed without staging unrelated dirty files.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";
import { createCommitChangesTool } from "../../src/tools/agent-verification-tools.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
import { ownerRoleTools } from "../../src/tools/owner-role-tool-policy.js";

const execFile = promisify(execFileCallback);

// Computes the canonical sha256 checksum string used to validate file contents before mutation and commit.
function sha256(content) {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

// Runs a Git command inside the disposable test repository and returns trimmed stdout for commit inspection.
async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args])).stdout.trim();
}

// Checks whether a filesystem path exists on disk after a delete or move mutation.
async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Creates an initialized Git repository with baseline committed files for mutation commit verification.
async function createGitMutationFixture(files = {}) {
  const root = await mkdtemp(join(tmpdir(), "nf-file-mutation-commits-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "NodeForge Test");
  await git(root, "config", "user.email", "nodeforge-test@localhost");
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await git(root, "add", ".gitignore", ...Object.keys(files));
  await git(root, "commit", "-qm", "baseline");
  const baseSha = await git(root, "rev-parse", "HEAD");
  const fileService = createFileService({ projectRoot: root });
  const gitService = createGitService({ projectRoot: root });
  return { root, baseSha, fileService, gitService };
}

test("AC-3: Coder delete_file and move_file through TicketChangeLedger and TicketRootCommitService stage and commit deleted and moved files cleanly", async () => {
  const obsoleteBody = "// Summary: Obsolete helper.\nexport const oldVal = 1;\n";
  const movingBody = "// Summary: Relocated service.\nexport const movedVal = 42;\n";
  const dirtyBody = "// Summary: Unrelated file.\nexport const keepVal = true;\n";
  const fixture = await createGitMutationFixture({
    "src/obsolete/remove-me.js": obsoleteBody,
    "src/old-dir/service.js": movingBody,
    "src/unrelated.js": dirtyBody
  });
  try {
    const { root, baseSha, fileService, gitService } = fixture;
    const taskId = "TICKET-MUT-COMMIT-1";
    const projectId = "PROJ-MUT-COMMIT";
    const ledger = createTicketChangeLedger({ fileService, projectId });
    const executionContexts = createTicketExecutionContextStore({ fileService, projectId, projectRoot: root });
    await executionContexts.create({
      taskId,
      supervisorId: "SUP-1",
      baseSha,
      baseline: {
        file_checksums: { "src/obsolete/remove-me.js": sha256(obsoleteBody), "src/old-dir/service.js": sha256(movingBody) },
        authorized_create_prefixes: ["src/new-dir"],
        mutable_file_budget: 3
      },
      authorizedCreatePrefixes: ["src/new-dir"],
      mutableFileBudget: 3
    });
    const rootCommitService = createTicketRootCommitService({
      taskId, projectId, projectRoot: root, fileService, ledger, gitService
    });
    const changeLedger = {
      write: async (change) => {
        await executionContexts.assertApprovedPath(taskId, change.path, { operation: change.after === null ? "delete" : "write" });
        return ledger.write({ ...change, taskId });
      },
      move: async (change) => {
        const fromPath = change.fromPath ?? change.from_path;
        const toPath = change.toPath ?? change.to_path;
        await executionContexts.assertApprovedPath(taskId, [{ path: fromPath, allowCreatePrefix: false }, { path: toPath, allowCreatePrefix: true }]);
        return ledger.move({ ...change, fromPath, toPath, taskId });
      },
      snapshot: () => ledger.snapshot(taskId),
      load: () => ledger.load(taskId)
    };
    const registry = createForgeToolRegistry({
      protocolStorage: { get: () => null },
      relevantTreeSelector: { selectRelevantTree: () => [] },
      freshnessChecker: { ensureFresh: () => ({ fresh: true }) },
      fileService,
      projectRoot: root,
      changeLedger,
      gitService: rootCommitService,
      executionContexts
    });
    const context = {
      task_id: taskId,
      execution_id: `${taskId}:EXEC-1`,
      project_id: projectId,
      project_root: root,
      agent_identity: { agent_id: "CODER-1", role: "coder", provider: "claude" },
      capabilities: [...CODER_TOOL_NAMES],
      allowed_file_paths: ["src/obsolete/remove-me.js", "src/old-dir/service.js"],
      allowed_prefixes: ["src/new-dir"],
      authorized_create_prefixes: ["src/new-dir"],
      mutable_file_budget: 3,
      changed_paths: [],
      execution_context: await executionContexts.load(taskId)
    };
    context.file_access_policy = issueExecutionFileAccess({
      context,
      readPaths: ["src/obsolete/remove-me.js", "src/old-dir/service.js"],
      readPrefixes: ["src"],
      policyIdentity: { id: "pol-commit", revision: "1", sha256: `sha256:${"c".repeat(64)}` },
      authorizeCurrent: () => true
    });
    context.file_access_version = 2;
    const bound = bindEngineeringTools({ registry, context });

    await writeFile(join(root, "src/unrelated.js"), "// dirty unrelated modification\n");
    await bound.registry.delete_file.execute({ path: "src/obsolete/remove-me.js", before_checksum: sha256(obsoleteBody) });
    await bound.registry.move_file.execute({
      from_path: "src/old-dir/service.js",
      to_path: "src/new-dir/service.js",
      before_checksum: sha256(movingBody)
    });
    const commitRes = await bound.registry.commit_changes.execute({ message: "delete obsolete and move service" });
    assert.match(commitRes.sha, /^[a-f0-9]{40,64}$/);

    const treeFiles = (await git(root, "ls-tree", "-r", "--name-only", commitRes.sha)).split("\n").filter(Boolean).sort();
    assert.deepEqual(treeFiles, [".gitignore", "src/new-dir/service.js", "src/unrelated.js"]);
    assert.equal(await git(root, "show", `${commitRes.sha}:src/new-dir/service.js`), movingBody.trimEnd());
    assert.equal(await git(root, "show", `${commitRes.sha}:src/unrelated.js`), dirtyBody.trimEnd());
    assert.equal(await readFile(join(root, "src/unrelated.js"), "utf8"), "// dirty unrelated modification\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AC-3 & AC-4: System Engineer delete_file and move_file record owner_changed_paths and commit_changes stages both deleted and moved paths via GitService", async () => {
  const dropContent = "// Summary: Drop me.\nexport const drop = 1;\n";
  const moveContent = "// Summary: Move me.\nexport const move = 2;\n";
  const keepContent = "// Summary: Keep me.\nexport const keep = 3;\n";
  const fixture = await createGitMutationFixture({
    "src/drop.js": dropContent,
    "src/legacy/item.js": moveContent,
    "src/keep.js": keepContent
  });
  try {
    const { root, fileService, gitService } = fixture;
    const state = new Map([["CONV-SE-COMMIT", { owner_changed_paths: [] }]]);
    const conversationStateStore = {
      get: async (id) => state.get(id),
      update: async (id, fields) => { state.set(id, { ...state.get(id), ...fields }); return state.get(id); }
    };
    const seContext = {
      task_id: "SE-COMMIT-1",
      execution_id: "SE-COMMIT-1",
      conversation_id: "CONV-SE-COMMIT",
      project_root: root,
      project_wide_access: true,
      capabilities: [...ownerRoleTools("system_engineer")],
      agent_identity: { agent_id: "se", role: "system_engineer", provider: "claude" },
      changed_paths: []
    };
    const seTools = createOwnerConversationTools({
      role: "system_engineer",
      projectRoot: root,
      fileService,
      gitService,
      conversationStateStore,
      conversationId: "CONV-SE-COMMIT",
      context: seContext
    });

    await seTools.registry.delete_file.execute({ path: "src/drop.js", before_checksum: sha256(dropContent) }, seContext);
    await seTools.registry.move_file.execute({
      from_path: "src/legacy/item.js",
      to_path: "src/modern/item.js",
      before_checksum: sha256(moveContent)
    }, seContext);

    assert.deepEqual(state.get("CONV-SE-COMMIT").owner_changed_paths.sort(), ["src/drop.js", "src/legacy/item.js", "src/modern/item.js"]);
    assert.equal(await pathExists(join(root, "src/drop.js")), false);
    assert.equal(await pathExists(join(root, "src/legacy/item.js")), false);
    assert.equal(await pathExists(join(root, "src/modern/item.js")), true);

    const committed = await seTools.registry.commit_changes.execute({ message: "se delete and move" }, seContext);
    assert.match(committed.sha, /^[a-f0-9]{40,64}$/);
    assert.deepEqual(committed.paths, ["src/drop.js", "src/legacy/item.js", "src/modern/item.js"]);
    assert.deepEqual(state.get("CONV-SE-COMMIT").owner_changed_paths, []);
    assert.equal(state.get("CONV-SE-COMMIT").owner_last_commit_sha, committed.sha);

    const headFiles = (await git(root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n").filter(Boolean).sort();
    assert.deepEqual(headFiles, [".gitignore", "src/keep.js", "src/modern/item.js"]);
    assert.equal(await git(root, "status", "--porcelain"), "");

    // Direct createCommitChangesTool without ledger also commits deleted paths cleanly.
    await fileService.deleteFile({ path: "src/keep.js" });
    const directTool = createCommitChangesTool({ gitService, logger: { emit: () => {} } });
    const directRes = await directTool.execute({ message: "delete keep" }, {
      task_id: "T-DEL",
      capabilities: ["commit_changes"],
      changed_paths: ["src/keep.js"],
      allowed_file_paths: ["src/keep.js"]
    });
    assert.match(directRes.sha, /^[a-f0-9]{40,64}$/);
    const finalFiles = (await git(root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n").filter(Boolean).sort();
    assert.deepEqual(finalFiles, [".gitignore", "src/modern/item.js"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
