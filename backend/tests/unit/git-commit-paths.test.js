// Exercises real Git repositories to keep all agent commit flows consistent with Git ignore semantics.
// Tests cover nested negations, tracked ignored files, deletion, stale ledgers and pushing to a local remote.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitCommitPaths } from "../../src/infrastructure/git/git-commit-paths.js";
import { handoffWorkspaceSnapshot } from "../../src/application/am-se-handoff-workspace.js";
import { buildRvImplementationReviewPrompt } from "../../src/application/am-se-handoff-helpers.js";
import { createOwnerEngineerTools } from "../../src/tools/roles/owner-engineer-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket/ticket-root-commit-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { snapshotWorkingTree, reconcileWorkingTreeMutation } from "../../src/infrastructure/git/workspace-ledger-sync.js";
const exec = promisify(execFile);

test("cleanup commits untracking without adding local ignored files or unrelated staging", async (t) => {
  const { root, git } = await fixture(t);
  await git("update-index", "--force-remove", "ignored-tracked.txt");
  await writeFile(join(root, "tracked.txt"), "source changed");
  await writeFile(join(root, "unrelated.txt"), "outside");
  await git("add", "unrelated.txt");
  const result = await createGitService({ projectRoot: root }).commit("source and cleanup", {
    paths: ["tracked.txt", "ignored-tracked.txt"]
  });
  assert.deepEqual((await git("diff-tree", "--no-commit-id", "--name-only", "-r", result.sha)).trim().split("\n").sort(),
    ["ignored-tracked.txt", "tracked.txt"]);
  assert.equal((await git("ls-files", "ignored-tracked.txt")).trim(), "");
  assert.equal((await git("diff", "--cached", "--name-only")).trim(), "unrelated.txt");
  await assert.doesNotReject(() => import("node:fs/promises").then(({ access }) => access(join(root, "ignored-tracked.txt"))));
});

test("handoff review removes ignored paths from old explicit scopes and explains local evidence", async (t) => {
  const { root } = await fixture(t);
  const gitService = createGitService({ projectRoot: root });
  const workspace = await handoffWorkspaceSnapshot({
    gitService, fileService: createFileService({ projectRoot: root }), projectId: "P",
    scopePaths: ["tracked.txt", "ignored-tracked.txt", "runtime/cache", ".next/trace", ".forge/runtime/old.json"]
  });
  assert.deepEqual(workspace.scope_paths, ["tracked.txt"]);
  assert.deepEqual(Object.keys(workspace.files), ["tracked.txt"]);
  const prompt = buildRvImplementationReviewPrompt({ planId: "P", round: 1, maxRounds: 2, workspace });
  assert.match(prompt, /must not be requested for commit or push/);
  assert.match(prompt, /scope_paths=\["tracked.txt"\]/);
});

// Creates an isolated repository and bare remote so integration checks never alter the user's branch.
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "forge-git-paths-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout;
  await git("init", "-b", "agent-work");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Forge test");
  await writeFile(join(root, "tracked.txt"), "before");
  await writeFile(join(root, "ignored-tracked.txt"), "local baseline");
  await writeFile(join(root, "deleted.txt"), "before");
  await git("add", ".");
  await git("commit", "-m", "baseline");
  await writeFile(join(root, ".gitignore"), "runtime/\n.next/\nignored-tracked.txt\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", ".gitignore"), "*.tmp\n!keep.tmp\n");
  await writeFile(join(root, "src", "hidden.tmp"), "ignored");
  await writeFile(join(root, "src", "keep.tmp"), "visible");
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime", "cache"), "ignored");
  await writeFile(join(root, "ignored-tracked.txt"), "local changed");
  await mkdir(join(root, ".next"));
  await writeFile(join(root, ".next", "trace"), "ignored");
  return { root, base, git };
}

test("Git inventory respects nested negations, info excludes, tracked ignored files and staged deletions", async (t) => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, ".git", "info", "exclude"), "local-only.txt\n");
  await writeFile(join(root, "local-only.txt"), "local");
  await git("rm", "deleted.txt");
  const paths = await gitCommitPaths(root);
  for (const path of ["tracked.txt", "deleted.txt", "src/keep.tmp"]) assert.ok(paths.has(path), path);
  for (const path of ["ignored-tracked.txt", "runtime/cache", ".next/trace", "src/hidden.tmp", "local-only.txt"]) assert.ok(!paths.has(path), path);
});

test("command reconciliation cleans stale ignored paths and records tracked edits and deletions", async (t) => {
  const { root } = await fixture(t);
  const beforeSnapshot = await snapshotWorkingTree(root);
  await writeFile(join(root, "tracked.txt"), "after");
  await rm(join(root, "deleted.txt"));
  await writeFile(join(root, "runtime", "cache"), "background update");
  const context = { changed_paths: ["runtime/vanished", ".next/trace"] };
  let state = { owner_changed_paths: ["runtime/vanished", ".next/trace"] };
  const result = await reconcileWorkingTreeMutation({
    projectRoot: root, beforeSnapshot, context, conversationId: "SE",
    conversationStateStore: { get: async () => state, update: async (_id, patch) => { state = { ...state, ...patch }; } }
  });
  assert.deepEqual(result.changed_paths, ["deleted.txt", "tracked.txt"]);
  assert.deepEqual(state.owner_changed_paths, result.changed_paths);
});

test("shared Git service filters a dirty ledger, commits tracked deletion and pushes the exact SHA", async (t) => {
  const { root, base, git } = await fixture(t);
  await writeFile(join(root, "tracked.txt"), "after");
  await rm(join(root, "deleted.txt"));
  const service = createGitService({ projectRoot: root });
  const result = await service.commit("safe agent commit", { paths: ["ignored-tracked.txt", "tracked.txt", "deleted.txt", "src/keep.tmp", "runtime/cache", "runtime/vanished", ".next/trace"] });
  const files = (await git("diff-tree", "--no-commit-id", "--name-only", "-r", result.sha)).trim().split("\n").sort();
  assert.deepEqual(files, ["deleted.txt", "src/keep.tmp", "tracked.txt"]);
  const remote = join(base, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await git("remote", "add", "origin", remote);
  assert.equal((await service.pushCommit(result.sha)).sha, result.sha);
  assert.equal((await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/agent-work"])).stdout.trim(), result.sha);
});

test("ticket commits exclude ignored manifest entries and safely repeat after service recreation", async (t) => {
  const { root, git } = await fixture(t);
  const fileService = createFileService({ projectRoot: root });
  const ledger = createTicketChangeLedger({ fileService, projectId: "P-IGNORE" });
  const service = () => createTicketRootCommitService({
    taskId: "T-IGNORE", projectId: "P-IGNORE", projectRoot: root, fileService, ledger,
    gitService: createGitService({ projectRoot: root })
  });
  await ledger.write({ taskId: "T-IGNORE", path: "tracked.txt", before: "before", after: "ticket edit" });
  await ledger.write({ taskId: "T-IGNORE", path: "runtime/cache", before: "ignored", after: "temporary" });
  await rm(join(root, "runtime", "cache"));
  const result = await service().commit("ticket source only");
  assert.equal((await git("diff-tree", "--no-commit-id", "--name-only", "-r", result.sha)).trim(), "tracked.txt");
  assert.equal((await service().commit("repeat")).sha, result.sha);
});

for (const conversationId of ["CONV-SE-OWNER", "CONV-SE-PLAN-AM-SE-RV", "CONV-SE-SL-HANDOFF"]) {
  test(`commit_changes and push_commit preserve conversation ownership for ${conversationId}`, async (t) => {
    const { root, base, git } = await fixture(t);
    await writeFile(join(root, "tracked.txt"), "owned edit");
    let state = { owner_changed_paths: ["tracked.txt", "runtime/vanished", ".next/trace"] };
    const tools = createOwnerEngineerTools({
      projectRoot: root, gitService: createGitService({ projectRoot: root }),
      conversationStateStore: { get: async () => state, update: async (_id, patch) => { state = { ...state, ...patch }; } }
    }).implementations;
    const context = { conversation_id: conversationId };
    const result = await tools.commit_changes.execute({ message: "owned commit" }, context);
    assert.deepEqual(result.paths, ["tracked.txt"]);
    assert.deepEqual(state.owner_last_commit_paths, ["tracked.txt"]);
    assert.deepEqual(state.owner_changed_paths, []);
    const remote = join(base, "owner-remote.git");
    await exec("git", ["init", "--bare", remote]);
    await git("remote", "add", "origin", remote);
    await assert.rejects(() => tools.push_commit.execute({ commit_sha: "a".repeat(40) }, context),
      (error) => error.code === "PUSH_COMMIT_SCOPE_INVALID");
    assert.equal((await tools.push_commit.execute({ commit_sha: result.sha }, context)).sha, result.sha);
  });
}
