// Proves concurrent disjoint ticket commits serialize on one root branch without staging other source.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";

const execFile = promisify(callback);

// Runs a Git command in the disposable concurrency witness repository.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

test("two disjoint ticket commits serialize and an overlapping write loses its file claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-concurrent-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.md"), "A before\n");
    await writeFile(join(root, "b.md"), "B before\n");
    await git(root, "add", ".gitignore", "a.md", "b.md");
    await git(root, "commit", "-qm", "baseline");
    const parent = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(join(root, ".git/index"));
    const files = createFileService({ projectRoot: root });
    const projectId = "P-CONCURRENT";
    const ledger = createTicketChangeLedger({ fileService: files, projectId });
    const service = (taskId) => createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    await ledger.write({ taskId: "TICKET-A", path: "a.md", before: "A before\n", after: "A after\n" });
    await ledger.write({ taskId: "TICKET-B", path: "b.md", before: "B before\n", after: "B after\n" });
    await assert.rejects(ledger.write({ taskId: "TICKET-C", path: "a.md", before: "A after\n", after: "C after\n" }), (error) => error.code === "FILE_CLAIM_CONFLICT");
    const [a, b] = await Promise.all([service("TICKET-A").commit("ticket A"), service("TICKET-B").commit("ticket B")]);
    assert.notEqual(a.sha, b.sha);
    assert.equal(await git(root, "rev-list", "--count", `${parent}..HEAD`), "2");
    assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
    assert.deepEqual((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", a.sha)).split("\n"), ["a.md"]);
    assert.deepEqual((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", b.sha)).split("\n"), ["b.md"]);
    assert.equal(await readFile(join(root, "a.md"), "utf8"), "A after\n");
    assert.equal(await readFile(join(root, "b.md"), "utf8"), "B after\n");
    // Locates the project claim so a competing owner can be simulated after commit.
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const claimPath = `.forge/runtime/ticket-changes/${hash(projectId)}/claims/${hash("a.md")}.json`;
    await files.atomicWrite({ path: claimPath, content: JSON.stringify({ task_id: "TICKET-C", path: "a.md" }), replace: true });
    await assert.rejects(service("TICKET-A").commit("ticket A"), { code: "FILE_CLAIM_CONFLICT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manifest-only commit records one new file and one deletion without changing staged unrelated source", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-add-delete-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "old.md"), "old\n");
    await writeFile(join(root, "other.md"), "original\n");
    await git(root, "add", ".gitignore", "old.md", "other.md");
    await git(root, "commit", "-qm", "baseline");
    await writeFile(join(root, "other.md"), "staged unrelated\n");
    await git(root, "add", "other.md");
    const indexBefore = await readFile(join(root, ".git/index"));
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "P-ADD-DELETE" });
    await ledger.write({ taskId: "T-ADD-DELETE", path: "old.md", before: "old\n", after: null });
    await ledger.write({ taskId: "T-ADD-DELETE", path: "new.md", before: null, after: "new\n" });
    const service = createTicketRootCommitService({ taskId: "T-ADD-DELETE", projectId: "P-ADD-DELETE", projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    const result = await service.commit("replace ticket file");
    assert.deepEqual((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", result.sha)).split("\n"), ["new.md", "old.md"]);
    assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
    assert.equal(await git(root, "show", `${result.sha}:new.md`), "new");
    await ledger.write({ taskId: "T-ADD-DELETE", path: "new.md", before: "new\n", after: "updated\n" });
    await chmod(join(root, "new.md"), 0o755);
    await assert.rejects(service.commit("unexpected mode change"), { code: "TICKET_PATH_CONFLICT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ticket root Git rejects aliased and symlink paths before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-path-"));
  try {
    await symlink("outside", join(root, "linked"));
    const git = createTicketRootGit({ projectRoot: root });
    await assert.rejects(git.assertSafePath("a/../b.js"), { code: "TICKET_PATH_CONFLICT" });
    await assert.rejects(git.assertSafePath("linked/file.js"), { code: "TICKET_PATH_CONFLICT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("branch movement before CAS blocks the ticket without advancing its candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-ref-race-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.md"), "before\n");
    await git(root, "add", ".gitignore", "a.md");
    await git(root, "commit", "-qm", "baseline");
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "P-RACE" });
    await ledger.write({ taskId: "T-RACE", path: "a.md", before: "before\n", after: "after\n" });
    const baseGit = createGitService({ projectRoot: root });
    let reads = 0;
    // Moves the project branch during ticket preparation to prove CAS cannot overwrite another commit.
    const racedGit = { ...baseGit, getHead: async () => {
      reads += 1;
      if (reads === 2) await git(root, "commit", "--allow-empty", "-qm", "external move");
      return baseGit.getHead();
    } };
    const service = createTicketRootCommitService({ taskId: "T-RACE", projectId: "P-RACE", projectRoot: root, fileService: files, ledger, gitService: racedGit });
    await assert.rejects(service.commit("ticket candidate"), { code: "TICKET_REF_CONFLICT" });
    assert.equal(await git(root, "show", "-s", "--format=%s", "HEAD"), "external move");
    assert.equal(await git(root, "show", "HEAD:a.md"), "before");
  } finally { await rm(root, { recursive: true, force: true }); }
});
