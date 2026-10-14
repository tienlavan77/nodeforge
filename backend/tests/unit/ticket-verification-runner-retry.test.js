// Verifies final reporting can rerun a repaired browser verifier on unchanged ticket code without bypassing failure gates.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { CODING_BROWSER_ASSERTIONS } from "../../src/modules/supervisor/browser-coding-contract.js";

// Preserves previous failed receipts, runs real admission, and enforces two attempts for the repaired runner after restart.
test("repaired browser runner admits unchanged ticket and retains bounded failure retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-runner-retry-"));
  try {
    const files = createFileService({ projectRoot: root });
    const taskId = "TICKET-RUNNER-RETRY";
    const baseSha = "a".repeat(40);
    const commitSha = "b".repeat(40);
    const path = "schemas/retry.json";
    const content = "{}\n";
    await files.atomicWrite({ path, content, replace: true });
    const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const manifest = { revision: 1, entries: { [path]: { initial_sha: null, latest_sha: checksum } }, commits: { 1: commitSha } };
    const contexts = createTicketExecutionContextStore({ fileService: files, projectId: "PROJECT-TEST", projectRoot: root });
    await contexts.create({ taskId, supervisorId: "SUP-RETRY", baseSha, verificationPlan: [{ kind: "browser", assertions: [CODING_BROWSER_ASSERTIONS[10]], viewports: [375] }] });
    const coding = await contexts.syncManifest(taskId, manifest);
    const context = await contexts.update(taskId, coding.version, { state: "committed", review_commit_sha: commitSha });
    for (const attempt of [1, 2]) {
      await files.atomicWrite({ path: `.forge/runtime/ticket-verification/${taskId}/jobs/VERIFY-old-${attempt}.json`, content: JSON.stringify({ job_id: `VERIFY-old-${attempt}`, attempt, status: "failed", commit_sha: commitSha, source_revision: context.source_revision, policy_version: "ticket-verification-v6", error: { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" } }), replace: false });
    }
    let runs = 0;
    const options = { taskId, projectId: "PROJECT-TEST", projectRoot: root, worktreeRoot: root,
      worktreeFileService: files, stateFileService: files, gitService: { getHead: async () => commitSha, getCommitParent: async () => baseSha, getChangedFiles: async () => [path], status: async () => "" },
      ledger: { snapshot: async () => manifest }, executionContexts: contexts,
      runCommand: async () => { runs += 1; return { exit_code: 1, stdout: "", stderr: "ENOSPC: no space left on device" }; } };
    for (const attempt of [1, 2]) {
      const service = createTicketVerificationService(options);
      const started = await service.startTests();
      assert.equal(started.attempt, attempt);
      let result;
      for (let poll = 0; poll < 100; poll += 1) {
        result = await service.getTestResult({ jobId: started.job_id });
        if (result.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "VERIFY_STORAGE_EXHAUSTED");
      assert.match(result.runner_revision, /^sha256:/);
    }
    await assert.rejects(createTicketVerificationService(options).startTests(), { code: "VERIFY_RETRY_UNCHANGED" });
    assert.equal(runs, 2);
    assert.equal((await contexts.load(taskId)).review_commit_sha, commitSha);
    assert.equal((await contexts.load(taskId)).verification_artifact_id, null);
    assert.equal(JSON.parse(await files.readFile({ path: `.forge/runtime/ticket-verification/${taskId}/jobs/VERIFY-old-2.json` })).attempt, 2);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
});
