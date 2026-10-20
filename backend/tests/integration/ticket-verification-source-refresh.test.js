// Verifies ticket commits with uncommitted project dependencies without changing ownership or the Git index.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { createTicketCommitFileService } from "../../src/modules/supervisor/ticket-commit-file-service.js";

// Builds a committed ticket with disposable Git provenance and a missing project dependency.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-source-refresh-"));
  const git = createTicketRootGit({ projectRoot: root });
  await git.run(["init"]); await git.run(["config", "user.name", "Fixture"]); await git.run(["config", "user.email", "fixture@example.invalid"]);
  await mkdir(join(root, "backend")); await writeFile(join(root, ".gitignore"), ".forge/\n");
  await writeFile(join(root, "ticket.md"), "before\n"); await writeFile(join(root, "unrelated.md"), "original\n");
  await git.run(["add", ".gitignore", "ticket.md", "unrelated.md"]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  const base = (await git.run(["rev-parse", "HEAD"])).trim();
  const files = createFileService({ projectRoot: root }); const projectId = "P-REFRESH"; const taskId = "TICKET-REFRESH";
  const ledger = createTicketChangeLedger({ fileService: files, projectId });
  const contexts = createTicketExecutionContextStore({ fileService: files, projectId, projectRoot: root });
  const commits = createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService: files, ledger, gitService: createGitService({ projectRoot: root }) });
  await contexts.create({ taskId, supervisorId: "SUP", baseSha: base });
  await ledger.write({ taskId, path: "ticket.md", before: "before\n", after: "after\n" });
  await contexts.syncManifest(taskId, await ledger.load(taskId));
  const original = (await commits.commit("ticket" )).sha;
  let context = await contexts.load(taskId); await contexts.update(taskId, context.version, { state: "committed", review_commit_sha: original });
  const options = { taskId, projectId, projectRoot: root, worktreeRoot: root, stateFileService: files, worktreeFileService: files, gitService: commits, ledger, executionContexts: contexts, rootOnly: true,
    runCommand: async ({ cwd }) => {
      try {
        const dependency = await readFile(join(cwd, "backend/dependency.js"), "utf8");
        assert.equal(await readFile(join(cwd, "ticket.md"), "utf8"), "after\n");
        assert(dependency.length);
        return { exit_code: 0, stdout: "pass", stderr: "" };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { exit_code: 1, stdout: `Error: Cannot find module '${cwd}/backend/dependency.js' imported from startup.js`, stderr: "" };
      }
    } };
  let service = createTicketVerificationService(options);
  // Waits only on fixture-owned verification and fails if the durable result never becomes terminal.
  async function finish() {
    const job = await service.startTests();
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await service.getTestResult({ jobId: job.job_id });
      if (result.status !== "running") return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Fixture verification never finished");
  }
  return { root, git, files, contexts, ledger, commits, original, taskId, finish,
    service: () => service, restart: () => { service = createTicketVerificationService(options); }, close: () => rm(root, { recursive: true, force: true }) };
}

// Proves unrelated tracked, staged and untracked inputs are available without expanding the ticket commit.
test("verification accepts uncommitted project dependencies and preserves Git index, HEAD and ticket ownership", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.finish()).status, "failed");
    assert.equal((await f.finish()).status, "failed");
    await assert.rejects(f.service().startTests(), { code: "VERIFY_RETRY_UNCHANGED" });
    await writeFile(join(f.root, "backend/dependency.js"), "export const dependency = true;\n");
    await writeFile(join(f.root, "unrelated.md"), "dirty owner work\n");
    await f.git.run(["add", "unrelated.md"]);
    await writeFile(join(f.root, "ticket.md"), "different live ticket bytes\n");
    const index = await readFile(join(f.root, ".git/index"));
    const status = await f.git.run(["status", "--porcelain"]);
    f.restart();
    const result = await f.finish(); assert.equal(result.status, "passed", JSON.stringify(result.error));
    const context = await f.contexts.load(f.taskId);
    const artifact = await f.service().assertPassedArtifact();
    assert.equal(context.review_commit_sha, f.original);
    assert.equal(artifact.commit_sha, f.original);
    assert.deepEqual(artifact.changed_paths, ["ticket.md"]);
    assert.equal(artifact.materialization_method, "ticket-commit-with-project-environment");
    assert(artifact.environment.sha256);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
    assert.equal(await f.git.run(["status", "--porcelain"]), status);
    assert.equal((await f.git.run(["rev-parse", "HEAD"])).trim(), f.original);
    assert.equal(await f.git.fileAt(f.original, "backend/dependency.js"), null);
    await writeFile(join(f.root, "backend/dependency.js"), "later live dependency\n");
    const review = createTicketCommitFileService({ taskId: f.taskId, projectRoot: f.root, executionContexts: f.contexts });
    assert.equal(await review.readFile({ path: "backend/dependency.js" }), "export const dependency = true;\n");
    assert.equal(await review.readFile({ path: "ticket.md" }), "after\n");
    assert.equal(await review.readFile({ path: "unrelated.md" }), "dirty owner work\n");
    assert((await review.listFiles()).includes("backend/dependency.js"));
    f.restart(); assert.equal((await f.finish()).status, "passed");
    assert.equal((await f.service().assertPassedArtifact()).artifact_id, artifact.artifact_id);
  } finally { await f.close(); }
});

// New ticket changes still invalidate acceptance and require an actual ticket commit.
test("Coder edits invalidate verification while environment edits never require recommitting the ticket", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "backend/dependency.js"), "dependency\n");
    assert.equal((await f.finish()).status, "passed");
    await f.ledger.write({ taskId: f.taskId, path: "ticket.md", before: "after\n", after: "next\n" });
    const next = await f.contexts.syncManifest(f.taskId, await f.ledger.load(f.taskId));
    assert.equal(next.review_commit_sha, null); assert.equal(next.state, "coding");
    await assert.rejects(f.service().startTests(), { code: "TICKET_COMMIT_REQUIRED" });
  } finally { await f.close(); }
});

// Upgrades unfinished legacy evidence automatically without reopening Coder or altering its commit.
test("legacy passed evidence refreshes once under the environment policy without a new ticket commit", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "backend/dependency.js"), "dependency\n");
    assert.equal((await f.finish()).status, "passed");
    const artifact = await f.service().assertPassedArtifact();
    const context = await f.contexts.load(f.taskId);
    const legacy = { ...artifact, artifact_id: "ARTIFACT-LEGACY", policy_version: "ticket-verification-v6", environment: null };
    await f.files.atomicWrite({ path: `.forge/runtime/ticket-verification/${f.taskId}/artifacts/${legacy.artifact_id}.json`, content: JSON.stringify(legacy), replace: false });
    await f.contexts.update(f.taskId, context.version, { verification_artifact_id: legacy.artifact_id });
    f.restart();
    assert.equal((await f.finish()).status, "passed");
    const refreshed = await f.service().assertPassedArtifact();
    assert.notEqual(refreshed.artifact_id, legacy.artifact_id);
    assert.equal(refreshed.policy_version, "ticket-verification-v8"); assert.equal(refreshed.commit_sha, f.original);
    assert.equal((await f.service().loadArtifact(legacy.artifact_id)).policy_version, "ticket-verification-v6");
  } finally { await f.close(); }
});
