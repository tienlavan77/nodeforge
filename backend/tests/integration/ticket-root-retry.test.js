// Proves an audited same-ticket retry preserves a prepared journal without changing unrelated Git state.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";

const execFile = promisify(callback);
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Runs a Git command inside one disposable ticket project.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

test("same-ticket retry preserves the prepared journal and commits only after reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-retry-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.js"), "before\n");
    await writeFile(join(root, "outside.js"), "outside\n");
    await git(root, "add", ".gitignore", "a.js", "outside.js");
    await git(root, "commit", "-qm", "baseline");
    const parent = await git(root, "rev-parse", "HEAD");
    const projectId = "P-RETRY";
    const taskId = "T-RETRY";
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId });
    const service = createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    await ledger.write({ taskId, path: "a.js", before: "before\n", after: "after\n" });
    const manifest = await ledger.load(taskId);
    const dir = `.forge/runtime/ticket-root-commits/${hash(projectId)}`;
    const originalPath = `${dir}/${hash(taskId)}-${manifest.revision}.json`;
    const manifestSha = `sha256:${hash(JSON.stringify([{ path: "a.js", before_sha: manifest.entries["a.js"].initial_sha, after_sha: manifest.entries["a.js"].latest_sha }]))}`;
    const original = { task_id: taskId, project_id: projectId, transaction_id: "old-prepared", revision: manifest.revision, parent_sha: parent, branch: await git(root, "symbolic-ref", "HEAD"), manifest_sha: manifestSha, path_checksums: { "a.js": manifest.entries["a.js"].latest_sha }, changed_paths: ["a.js"], phase: "prepared" };
    await files.atomicWrite({ path: originalPath, content: `${JSON.stringify(original)}\n`, replace: false });
    await assert.rejects(service.commit("ticket retry"), (error) => error.code === "TICKET_COMMIT_RECOVERY_CONFLICT");
    await writeFile(join(root, "outside.js"), "dirty outside\n");
    await git(root, "add", "outside.js");
    const indexBefore = await readFile(join(root, ".git/index"));
    const disposition = await service.reconcileNoRefMove();
    assert.equal(disposition.disposition, "reconciled_no_ref_move");
    assert.deepEqual(JSON.parse(await files.readFile({ path: originalPath })), original);
    assert.deepEqual(await service.reconcileNoRefMove(), disposition);
    const result = await service.commit("ticket retry");
    assert.equal(await git(root, "rev-parse", "HEAD"), result.sha);
    assert.equal(await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", result.sha), "a.js");
    assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
    assert.equal(JSON.parse(await files.readFile({ path: `${dir}/${hash(taskId)}-${manifest.revision}-retry.json` })).phase, "receipt_persisted");
    assert.deepEqual(JSON.parse(await files.readFile({ path: originalPath })), original);
    await ledger.write({ taskId, path: "a.js", before: "after\n", after: "before\n" });
    await ledger.write({ taskId, path: "a.js", before: "before\n", after: "after\n" });
    await assert.rejects(service.commit("no net change"), (error) => error.code === "GIT_EMPTY_COMMIT");
    await ledger.write({ taskId, path: "new.js", before: null, after: "new file\n" });
    const next = await service.commit("new file only");
    assert.equal(await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", next.sha), "new.js");
    assert.deepEqual(JSON.parse(await files.readFile({ path: originalPath })), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
