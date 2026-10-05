// Proves root ticket commits include only ledger paths while leaving unrelated dirty source intact.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { createTicketCommitFileService } from "../../src/modules/supervisor/ticket-commit-file-service.js";
import { assertTicketReviewEvidence } from "../../src/modules/supervisor/ticket-review-evidence.js";

const execFile = promisify(callback);

// Executes a Git command in a disposable repository without changing the project checkout.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }
const key = (value) => createHash("sha256").update(value).digest("hex");

test("root ticket commit excludes unrelated dirt and rejects a dirty claimed baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-commit-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.js"), "const a = 1;\n");
    await writeFile(join(root, "b.js"), "const b = 1;\n");
    await git(root, "add", ".gitignore", "a.js", "b.js");
    await git(root, "commit", "-qm", "baseline");
    const parent = await git(root, "rev-parse", "HEAD");
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "P-ROOT" });
    const service = (taskId) => createTicketRootCommitService({ taskId, projectId: "P-ROOT", projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    await writeFile(join(root, "b.js"), "const b = 2;\n");
    await git(root, "add", "b.js");
    const indexBefore = await readFile(join(root, ".git/index"));
    await ledger.write({ taskId: "TICKET-A", path: "a.js", before: "const a = 1;\n", after: "const a = 2;\n" });
    const result = await service("TICKET-A").commit("ticket A");
    assert.deepEqual(await service("TICKET-A").getCommitsForTask("TICKET-A"), [{ sha: result.sha, subject: "ticket A" }]);
    assert.equal(await git(root, "rev-list", "--parents", "-n", "1", result.sha), `${result.sha} ${parent}`);
    assert.equal(await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", result.sha), "a.js");
    assert.equal(await readFile(join(root, "b.js"), "utf8"), "const b = 2;\n");
    assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
    assert.equal((await service("TICKET-A").commit("ticket A")).repeated, true);
    await ledger.write({ taskId: "TICKET-B", path: "b.js", before: "const b = 2;\n", after: "const b = 3;\n" });
    await assert.rejects(service("TICKET-B").commit("ticket B"), (error) => error.code === "TICKET_BASELINE_CONFLICT");
    assert.equal(await git(root, "rev-parse", "HEAD"), result.sha);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive verification and review remain bound to ticket A after ticket B advances root HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-evidence-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.md"), "A before\n");
    await writeFile(join(root, "b.md"), "B before\n");
    await git(root, "add", ".gitignore", "a.md", "b.md");
    await git(root, "commit", "-qm", "baseline");
    const base = await git(root, "rev-parse", "HEAD");
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "P-EVIDENCE" });
    const contexts = createTicketExecutionContextStore({ fileService: files, projectId: "P-EVIDENCE", projectRoot: root });
    const service = (taskId) => createTicketRootCommitService({ taskId, projectId: "P-EVIDENCE", projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    await contexts.create({ taskId: "TICKET-A", supervisorId: "SUP-A", baseSha: base });
    await ledger.write({ taskId: "TICKET-A", path: "a.md", before: "A before\n", after: "A after\n" });
    const manifest = await ledger.snapshot("TICKET-A");
    let context = await contexts.syncManifest("TICKET-A", manifest);
    const aCommit = await service("TICKET-A").commit("ticket A");
    await contexts.update("TICKET-A", context.version, { state: "committed", review_commit_sha: aCommit.sha });
    await ledger.write({ taskId: "TICKET-B", path: "b.md", before: "B before\n", after: "B after\n" });
    await service("TICKET-B").commit("ticket B");
    const newerHead = await git(root, "rev-parse", "HEAD");
    assert.notEqual(newerHead, aCommit.sha);
    await writeFile(join(root, "a.md"), "uncommitted root drift\n");
    let observedSource;
    const verification = createTicketVerificationService({ taskId: "TICKET-A", projectId: "P-EVIDENCE", projectRoot: root, worktreeRoot: root, worktreeFileService: files, stateFileService: files, gitService: service("TICKET-A"), ledger, executionContexts: contexts, rootOnly: true,
      runCommand: async ({ cwd }) => { observedSource = await readFile(join(cwd, "a.md"), "utf8"); return { exit_code: 0, stdout: "passed", stderr: "" }; } });
    const job = await verification.startTests();
    let result;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      result = await verification.getTestResult({ jobId: job.job_id });
      if (result.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(result.status, "passed", JSON.stringify(result.error));
    assert.equal(observedSource, "A after\n");
    const artifact = await verification.assertPassedArtifact();
    assert.equal(artifact.materialization_method, "git-archive");
    assert.equal(artifact.tree_sha, await git(root, "rev-parse", `${aCommit.sha}^{tree}`));
    const committedFiles = createTicketCommitFileService({ taskId: "TICKET-A", projectRoot: root, executionContexts: contexts });
    const review = await assertTicketReviewEvidence({ job: { task_id: "TICKET-A", payload: { changed_paths: ["a.md"], base_commit: base, commit: aCommit.sha } }, executionContexts: contexts, verificationService: verification, gitService: service("TICKET-A"), fileService: committedFiles, projectRoot: root });
    assert.equal(review.files[0].content, "A after\n");
    assert.equal(review.artifact.commit_sha, aCommit.sha);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart recovers a ref-advanced transaction once without staging unrelated dirt", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-recovery-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.md"), "before\n");
    await writeFile(join(root, "unrelated.md"), "clean\n");
    await git(root, "add", ".gitignore", "a.md", "unrelated.md");
    await git(root, "commit", "-qm", "baseline");
    const files = createFileService({ projectRoot: root });
    const projectId = "P-RECOVERY";
    const taskId = "T-RECOVERY";
    const ledger = createTicketChangeLedger({ fileService: files, projectId });
    const service = createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    const indexBefore = await readFile(join(root, ".git/index"));
    await ledger.write({ taskId, path: "a.md", before: "before\n", after: "after\n" });
    const beforeReceipt = await ledger.load(taskId);
    const committed = await service.commit("recoverable ticket");
    const journalPath = `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${beforeReceipt.revision}.json`;
    const journal = JSON.parse(await files.readFile({ path: journalPath }));
    await files.atomicWrite({ path: journalPath, content: JSON.stringify({ ...journal, phase: "branch_ref_advanced" }), replace: true });
    await files.atomicWrite({ path: `.forge/runtime/ticket-changes/${key(projectId)}/tickets/${key(taskId)}.json`, content: JSON.stringify(beforeReceipt), replace: true });
    await writeFile(join(root, "unrelated.md"), "dirty\n");
    const count = await git(root, "rev-list", "--count", "HEAD");
    const recovered = await service.commit("recoverable ticket");
    assert.equal(recovered.sha, committed.sha);
    assert.equal(recovered.recovered, true);
    assert.equal(await git(root, "rev-list", "--count", "HEAD"), count);
    assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
    assert.equal((await ledger.load(taskId)).commits[beforeReceipt.revision], committed.sha);
    assert.equal(JSON.parse(await files.readFile({ path: journalPath })).phase, "receipt_persisted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("object-created recovery advances the same commit and an unproven prepared journal quarantines", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-phase-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "a.md"), "before\n");
    await git(root, "add", ".gitignore", "a.md");
    await git(root, "commit", "-qm", "baseline");
    const parent = await git(root, "rev-parse", "HEAD");
    const files = createFileService({ projectRoot: root });
    const projectId = "P-PHASE";
    const taskId = "T-PHASE";
    const ledger = createTicketChangeLedger({ fileService: files, projectId });
    const service = createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    await ledger.write({ taskId, path: "a.md", before: "before\n", after: "after\n" });
    const beforeReceipt = await ledger.load(taskId);
    const indexBefore = await readFile(join(root, ".git/index"));
    const committed = await service.commit("ticket phase");
    const journalPath = `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${beforeReceipt.revision}.json`;
    const ledgerPath = `.forge/runtime/ticket-changes/${key(projectId)}/tickets/${key(taskId)}.json`;
    const journal = JSON.parse(await files.readFile({ path: journalPath }));
    await files.atomicWrite({ path: ledgerPath, content: JSON.stringify(beforeReceipt), replace: true });
    await files.atomicWrite({ path: journalPath, content: JSON.stringify({ ...journal, phase: "commit_object_created" }), replace: true });
    await git(root, "update-ref", journal.branch, parent, committed.sha);
    await writeFile(join(root, ".git/index"), indexBefore);
    assert.equal((await service.commit("ticket phase")).sha, committed.sha);
    assert.equal(await git(root, "rev-parse", "HEAD"), committed.sha);
    assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
    await git(root, "update-ref", journal.branch, parent, committed.sha);
    await writeFile(join(root, ".git/index"), indexBefore);
    await files.atomicWrite({ path: ledgerPath, content: JSON.stringify(beforeReceipt), replace: true });
    await files.atomicWrite({ path: journalPath, content: JSON.stringify({ ...journal, commit_sha: undefined, phase: "prepared" }), replace: true });
    assert.equal((await service.commit("ticket phase")).sha, committed.sha);
    assert.equal(await git(root, "rev-parse", "HEAD"), committed.sha);
    await files.atomicWrite({ path: ledgerPath, content: JSON.stringify(beforeReceipt), replace: true });
    await files.atomicWrite({ path: journalPath, content: JSON.stringify({ ...journal, commit_sha: undefined, tree_sha: parent, phase: "prepared" }), replace: true });
    await assert.rejects(service.commit("ticket phase"), (error) => error.code === "TICKET_COMMIT_RECOVERY_CONFLICT");
    assert.equal(await git(root, "rev-parse", "HEAD"), committed.sha);
    const quarantinePath = `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${beforeReceipt.revision}-${key(journal.transaction_id)}-${key("transaction_object_missing")}-quarantine.json`;
    const quarantine = JSON.parse(await files.readFile({ path: quarantinePath }));
    assert.equal(quarantine.disposition, "quarantined");
    assert.equal(quarantine.reason, "transaction_object_missing");
    const missingTree = { ...journal, transaction_id: `${journal.transaction_id}-missing`, tree_sha: undefined, commit_sha: undefined, phase: "prepared" };
    await files.atomicWrite({ path: journalPath, content: JSON.stringify(missingTree), replace: true });
    await assert.rejects(service.commit("ticket phase"), { code: "TICKET_COMMIT_RECOVERY_CONFLICT" });
    const missingAuditPath = `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${beforeReceipt.revision}-${key(missingTree.transaction_id)}-${key("candidate_tree_missing")}-quarantine.json`;
    assert.equal(JSON.parse(await files.readFile({ path: missingAuditPath })).reason, "candidate_tree_missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disposable archive runs the real verification command against its committed source", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-command-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
    await writeFile(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true }, include: ["a.js"] }));
    await writeFile(join(root, "a.js"), "export const value = 1;\n");
    await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    await git(root, "add", ".gitignore", "jsconfig.json", "a.js");
    await git(root, "commit", "-qm", "baseline");
    const files = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService: files, projectId: "P-COMMAND" });
    const contexts = createTicketExecutionContextStore({ fileService: files, projectId: "P-COMMAND", projectRoot: root });
    const taskId = "T-COMMAND";
    await contexts.create({ taskId, supervisorId: "SUP-COMMAND", baseSha: await git(root, "rev-parse", "HEAD") });
    await ledger.write({ taskId, path: "a.js", before: "export const value = 1;\n", after: "export const value = 2;\n" });
    const context = await contexts.syncManifest(taskId, await ledger.snapshot(taskId));
    const rootGit = createTicketRootCommitService({ taskId, projectId: "P-COMMAND", projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
    const committed = await rootGit.commit("real archive check");
    await contexts.update(taskId, context.version, { state: "committed", review_commit_sha: committed.sha });
    const verification = createTicketVerificationService({ taskId, projectId: "P-COMMAND", projectRoot: root, worktreeRoot: root, worktreeFileService: files, stateFileService: files, gitService: rootGit, ledger, executionContexts: contexts, rootOnly: true });
    const job = await verification.startTests();
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = await verification.getTestResult({ jobId: job.job_id });
      if (result.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(result.status, "passed", JSON.stringify(result.error ?? result.result));
    const artifact = await verification.assertPassedArtifact();
    assert.equal(artifact.commands[0].kind, "typecheck");
    assert.equal(artifact.commands[0].exit_code, 0);
    assert.equal(artifact.materialization_method, "git-archive");
    assert.equal(artifact.cwd.startsWith(join(root, ".forge/runtime/ticket-verification/archives/")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
