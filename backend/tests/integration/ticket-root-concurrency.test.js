// Proves concurrent disjoint ticket commits serialize on one root branch without staging other source.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as callback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";

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
    assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
    assert.deepEqual((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", a.sha)).split("\n"), ["a.md"]);
    assert.deepEqual((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", b.sha)).split("\n"), ["b.md"]);
    assert.equal(await readFile(join(root, "a.md"), "utf8"), "A after\n");
    assert.equal(await readFile(join(root, "b.md"), "utf8"), "B after\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
