// Verifies durable ticket identity, manifest hashing, and compare-and-swap recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketExecutionContextStore, prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { createHash } from "node:crypto";

const baseSha = "a".repeat(40);

// Creates two stores that simulate an API restart over the same project files.
test("ticket context persists identity and rejects stale transitions after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-context-"));
  try {
    const open = () => createTicketExecutionContextStore({ fileService: createFileService({ projectRoot: root }), projectId: "PROJECT-TEST", projectRoot: root });
    const first = open();
    const created = await first.create({ taskId: "TICKET-1", supervisorId: "SUP-1", baseSha });
    assert.equal(created.version, 1);
    assert.equal(created.execution_root, "project-root");
    assert.deepEqual(created.manifest_paths, []);
    const restarted = open();
    assert.deepEqual(await restarted.create({ taskId: "TICKET-1", supervisorId: "SUP-1", baseSha }), created);
    await assert.rejects(restarted.create({ taskId: "TICKET-1", supervisorId: "SUP-2", baseSha }), { code: "TICKET_CONTEXT_CONFLICT" });
    const manifest = { revision: 1, entries: { "backend/src/a.js": { initial_sha: "sha256:old", latest_sha: "sha256:new" } } };
    const changed = await restarted.syncManifest("TICKET-1", manifest);
    assert.equal(changed.version, 2);
    assert.equal(changed.state, "coding");
    assert.deepEqual(changed.manifest_paths, ["backend/src/a.js"]);
    assert.deepEqual(await first.load("TICKET-1"), changed);
    assert.deepEqual(await first.syncManifest("TICKET-1", manifest), changed);
    await assert.rejects(first.update("TICKET-1", 1, { state: "committed" }), { code: "TICKET_CONTEXT_VERSION_CONFLICT" });
    const committed = await first.update("TICKET-1", 2, { state: "committed", review_commit_sha: "b".repeat(40) });
    assert.equal(committed.version, 3);
    const next = await restarted.syncManifest("TICKET-1", { revision: 2, entries: { "backend/src/a.js": { initial_sha: "sha256:old", latest_sha: "sha256:newer" } } });
    assert.equal(next.review_commit_sha, null);
    assert.equal(next.verification_artifact_id, null);
    assert.notEqual(next.source_revision, committed.source_revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Confirms that concurrent context mutations accept exactly one expected version.
test("ticket context CAS serializes competing writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-context-cas-"));
  try {
    const options = { projectId: "PROJECT-TEST", projectRoot: root };
    const first = createTicketExecutionContextStore({ ...options, fileService: createFileService({ projectRoot: root }) });
    const second = createTicketExecutionContextStore({ ...options, fileService: createFileService({ projectRoot: root }) });
    await first.create({ taskId: "TICKET-2", supervisorId: "SUP-2", baseSha });
    const results = await Promise.allSettled([first.update("TICKET-2", 1, { state: "coding" }), second.update("TICKET-2", 1, { state: "committed" })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "TICKET_CONTEXT_VERSION_CONFLICT").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Prevents an existing worktree or ledger from gaining fabricated provenance on resume.
test("context preparation rejects pre-context changes and preserves the root identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-context-migration-"));
  try {
    const store = createTicketExecutionContextStore({ fileService: createFileService({ projectRoot: root }), projectId: "PROJECT-TEST", projectRoot: root });
    const legacy = { base_commit: baseSha, projectRoot: root, path: `${root}/.forge/worktrees/ticket`, executionContexts: store, changeLedger: { snapshot: async () => ({ revision: 1, entries: { "backend/a.js": { initial_sha: "sha256:a", latest_sha: "sha256:b" } }, commits: {} }) } };
    await assert.rejects(prepareTicketExecutionContext({ workspace: legacy, taskId: "TICKET-LEGACY", supervisorId: "SUP-LEGACY" }), { code: "TICKET_CONTEXT_MIGRATION_REQUIRED" });
    assert.equal(await store.load("TICKET-LEGACY"), null);
    const fresh = { ...legacy, changeLedger: { snapshot: async () => ({ revision: 0, entries: {}, commits: {} }) } };
    const prepared = await prepareTicketExecutionContext({ workspace: fresh, taskId: "TICKET-FRESH", supervisorId: "SUP-FRESH" });
    assert.equal(prepared.execution_root, "project-root");
    assert.equal(prepared.base_sha, baseSha);
    assert.notEqual(prepared.execution_root, fresh.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Keeps a passed verification receipt available after restart and refuses changed commit bytes.
test("ticket verification persists evidence for the exact ledger and commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verify-"));
  const worktreeRoot = join(root, "ticket-worktree");
  try {
    const stateFileService = createFileService({ projectRoot: root });
    const worktreeFileService = createFileService({ projectRoot: worktreeRoot });
    const path = "backend/src/feature.js";
    const content = "export const feature = true;\n";
    await worktreeFileService.atomicWrite({ path, content, replace: true });
    await mkdir(join(worktreeRoot, "backend/tests/unit"), { recursive: true });
    await writeFile(join(worktreeRoot, "backend/tests/unit/witness.test.js"), "// Provides a verification-plan test fixture.\n");
    const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const manifest = { revision: 1, entries: { [path]: { initial_sha: null, latest_sha: checksum } }, commits: { 1: "b".repeat(40) } };
    const executionContexts = createTicketExecutionContextStore({ fileService: stateFileService, projectId: "PROJECT-TEST", projectRoot: root });
    await executionContexts.create({ taskId: "TICKET-VERIFY", supervisorId: "SUP-VERIFY", baseSha });
    const coding = await executionContexts.syncManifest("TICKET-VERIFY", manifest);
    await executionContexts.update("TICKET-VERIFY", coding.version, { state: "committed", review_commit_sha: "b".repeat(40) });
    const inputs = { taskId: "TICKET-VERIFY", projectId: "PROJECT-TEST", projectRoot: root, worktreeRoot, worktreeFileService, stateFileService, gitService: { getHead: async () => "b".repeat(40), status: async () => "" }, ledger: { snapshot: async () => manifest }, executionContexts, runCommand: async () => ({ exit_code: 0, stdout: "token=secret123\npass", stderr: "" }) };
    const service = createTicketVerificationService(inputs);
    const started = await service.startTests();
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await service.getTestResult({ jobId: started.job_id, taskId: "TICKET-VERIFY" });
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.status, "passed", JSON.stringify(job));
    const restarted = createTicketVerificationService(inputs);
    assert.equal((await restarted.getTestResult({ jobId: started.job_id })).status, "passed");
    const artifact = await restarted.assertPassedArtifact();
    assert.equal(artifact.commit_sha, "b".repeat(40));
    assert.equal(artifact.file_checksums[path], checksum);
    assert.doesNotMatch(artifact.stdout_redacted, /secret123/);
    await worktreeFileService.atomicWrite({ path, content: "export const feature = false;\n", replace: true });
    await assert.rejects(restarted.assertPassedArtifact(), { code: "VERIFY_SOURCE_MISMATCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Stops a resumed Coder from rerunning failed verification until a new commit changes ticket evidence.
test("failed verification cannot rerun on an unchanged ticket commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verify-retry-"));
  try {
    const files = createFileService({ projectRoot: root });
    const path = "schemas/retry.json";
    const content = "{}\n";
    await files.atomicWrite({ path, content, replace: true });
    const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const manifest = { revision: 1, entries: { [path]: { initial_sha: null, latest_sha: checksum } }, commits: { 1: "b".repeat(40) } };
    const contexts = createTicketExecutionContextStore({ fileService: files, projectId: "PROJECT-TEST", projectRoot: root });
    await contexts.create({ taskId: "TICKET-RETRY", supervisorId: "SUP-RETRY", baseSha });
    const coding = await contexts.syncManifest("TICKET-RETRY", manifest);
    await contexts.update("TICKET-RETRY", coding.version, { state: "committed", review_commit_sha: "b".repeat(40) });
    let runs = 0;
    const options = { taskId: "TICKET-RETRY", projectId: "PROJECT-TEST", projectRoot: root, worktreeRoot: root,
      worktreeFileService: files, stateFileService: files, gitService: { getHead: async () => "b".repeat(40), status: async () => "" },
      ledger: { snapshot: async () => manifest }, executionContexts: contexts,
      runCommand: async () => { runs += 1; return { exit_code: 1, stdout: "failed", stderr: "" }; } };
    const service = createTicketVerificationService(options);
    const first = await service.startTests();
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = await service.getTestResult({ jobId: first.job_id });
      if (result.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.status, "failed");
    await assert.rejects(createTicketVerificationService(options).startTests(), { code: "VERIFY_RETRY_UNCHANGED" });
    assert.equal(runs, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
