/** Verifies the production run_check adapter materializes the final artifact's
 * recorded environment after live project files change. A real Git archive and
 * Node test process prove the passing receipt remains comparable to final
 * verification without recapturing unrelated workspace edits. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket/ticket-verification-service.js";
import { captureVerificationEnvironment, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";

/** Runs an actual focused test against recorded dependency bytes, then proves
 * corrupt snapshot evidence fails rather than falling back to live files. */
test("production run_check passes on the saved environment after live dependency drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-focused-environment-"));
  // Runs fixture Git commands only inside this test's disposable project.
  const git = async (...args) => (await promisify(execFile)("git", args, { cwd: root })).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "Verification Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    const files = createFileService({ projectRoot: root });
    const testPath = "backend/tests/unit/environment.test.js";
    await files.atomicWrite({ path: "config.txt", content: "recorded", replace: false });
    await files.atomicWrite({ path: testPath, content: "// Checks the recorded dependency snapshot.\nconst { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\ntest('recorded environment', () => assert.equal(fs.readFileSync('config.txt', 'utf8'), 'recorded'));\n", replace: false });
    await git("add", "config.txt", testPath);
    await git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture baseline");
    const baseSha = await git("rev-parse", "HEAD");
    const path = "backend/src/ticket.js", content = "// Supplies the committed ticket change.\nexport const value = true;\n";
    await files.atomicWrite({ path, content, replace: false });
    await git("add", path);
    await git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture ticket");
    const commit = await git("rev-parse", "HEAD");
    const captured = await captureVerificationEnvironment({ projectRoot: root, ticketPaths: [path] });
    const binding = await persistVerificationEnvironment(root, captured);
    await files.atomicWrite({ path: "config.txt", content: "unrelated live edit", replace: true });
    const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const context = { version: 1, state: "verified", base_sha: baseSha, review_commit_sha: commit, source_revision: "source", manifest_sha: "manifest", manifest_paths: [path], verification_artifact_id: "ARTIFACT-PASSED" };
    await files.atomicWrite({ path: ".forge/runtime/ticket-verification/TICKET/artifacts/ARTIFACT-PASSED.json", content: JSON.stringify({ artifact_id: context.verification_artifact_id, task_id: "TICKET", status: "passed", commit_sha: commit, source_revision: context.source_revision, manifest_sha: context.manifest_sha, environment: binding }), replace: false });
    const manifest = { entries: { [path]: { latest_sha: checksum } } };
    const service = createTicketVerificationService({ taskId: "TICKET", projectId: "PROJECT", projectRoot: root, worktreeRoot: root, rootOnly: true,
      worktreeFileService: files, stateFileService: files, gitService: { getHead: async () => commit }, ledger: { load: async () => manifest, snapshot: async () => manifest },
      executionContexts: { load: async () => context, manifestIdentity: () => ({ source_revision: context.source_revision, manifest_sha: context.manifest_sha, manifest_paths: [path] }) } });
    const receipt = await service.runCheck({ type: "test", command: `node --test ${testPath}` });
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.pre_commit, false);
    assert.equal(receipt.commit_sha, commit);
    assert.deepEqual(receipt.environment, binding);
    assert.deepEqual((await service.getTestResult({ jobId: receipt.check_id })).environment, binding);
    const config = captured.files.find((file) => file.path === "config.txt");
    await writeFile(join(root, ".forge/runtime/ticket-verification/environment/blobs", config.sha256), "corrupt");
    await assert.rejects(service.runCheck({ type: "test", command: `node --test ${testPath}` }), { code: "VERIFY_ENVIRONMENT_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
