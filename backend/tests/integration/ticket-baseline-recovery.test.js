/** Verifies real baseline dispatch, exact-environment restoration, continuation
 * and report gating without mutating production tickets or suppressing real failures. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { baselineFixture, failedBaseline } from "./ticket-baseline-recovery-fixture.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { baselineRecoveryRequest } from "../../src/modules/supervisor/ticket-baseline-recovery.js";
import { resolveRuntimePath } from "../../src/infrastructure/filesystem/forge-paths.js";
import { readBlockerVerificationHistory } from "../../src/modules/supervisor/blocker-verification-history.js";
import { createBlockerEvidenceFiles } from "../../src/modules/supervisor/blocker-evidence-files.js";
import { createBlockerFailureClassification, requiresEvidenceReconciliation } from "../../src/modules/supervisor/blocker-failure-classification.js";

test("Node restores baseline evidence, keeps passing checks and completes the remaining original plan", async () => {
  const f = await baselineFixture();
  try {
    const { job, artifact } = await failedBaseline(f);
    assert.equal(job.error.code, "VERIFY_BASELINE_UNAVAILABLE");
    assert.equal(f.calls.some(call => call.argv.includes(f.trailing)), false);
    const firstCount = f.calls.length;
    const oldBytes = JSON.stringify(artifact);
    await writeFile(join(f.root, f.regression), "throw Error('live workspace must not run');\n");
    const [result, duplicate] = await Promise.all([f.service.recoverBaseline({ executionId: "EXEC-1" }), f.service.recoverBaseline({ executionId: "EXEC-1" })]);
    assert.equal(result.status, "passed"); assert.equal(duplicate.artifact_id, result.artifact_id);
    assert.equal(f.context.state, "verified");
    const recovered = await f.service.assertPassedArtifact();
    assert.equal(recovered.commands.length, artifact.planned_commands.length);
    assert.deepEqual(recovered.environment, artifact.environment);
    assert.equal(recovered.base_sha, artifact.base_sha);
    const reruns = f.calls.slice(firstCount);
    assert.equal(reruns.length, 3);
    assert.equal(reruns.some(call => call.argv.includes(f.primary)), false);
    assert.equal(reruns.filter(call => call.argv.includes(f.regression)).length, 2);
    assert.equal(reruns.filter(call => call.argv.includes(f.trailing)).length, 1);
    assert.equal(recovered.commands.find(command => command.test_paths?.includes(f.regression)).disposition, "preexisting_failure");
    assert.equal(JSON.stringify(await f.service.loadArtifact(artifact.artifact_id)), oldBytes);
    assert.match(await readFile(join(f.root, f.regression), "utf8"), /live workspace/);
    const jobContext = { request: { task_id: f.context.task_id, project_id: "P" } };
    const history = await readBlockerVerificationHistory({ job: jobContext, workspace: { projectRoot: f.root }, context: f.context });
    assert.ok(history.receipt_index.some(entry => entry.evidence_ref === result.evidence_ref));
    for (const role of ["sprint_leader", "architecture_manager", "reviewer"]) {
      const granted = createBlockerEvidenceFiles({ files: f.files, projectRoot: f.root, profile: { role }, taskId: f.context.task_id,
        job: { ...jobContext, ticket_progress: { verification: { ...history, status: "observed", commit_sha: recovered.commit_sha, source_revision: recovered.source_revision } } } });
      const receipt = JSON.parse(await granted.files.readFile({ path: result.evidence_ref }));
      assert.equal(receipt.status, "passed"); assert.equal(receipt.execution_id, "EXEC-1");
    }
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1500);
    const classifier = createBlockerFailureClassification({ readFailureEvidence: async () => ({ status: "captured",
      receipts: [{ tool: "report_done", error: { code: "VERIFY_BASELINE_UNAVAILABLE" } }] }) });
    const recoveryJob = { ...jobContext, id: "RECOVERY", reason_code: "ACCESS_REQUIRED", failure_at: artifact.completed_at,
      request: { ...jobContext.request, execution_context: { ...f.context }, payload: { execution_id: "EXEC-1" } } };
    recoveryJob.ticket_progress = { failure_classification: await classifier(recoveryJob, {
      projectRoot: f.root, executionContexts: f.options.executionContexts, testService: f.service }) };
    assert.equal(recoveryJob.ticket_progress.failure_classification.effective_reason_code, "VERIFY_RECOVERY_READY");
    assert.equal(requiresEvidenceReconciliation(recoveryJob), false);
    assert.equal(await createTicketVerificationService(f.options).recoverBaseline({ executionId: "EXEC-1" }), null);
    assert.equal(f.calls.length, firstCount + 3);
  } finally { await f.close(); }
});

test("introduced regression stays failed and is returned without an unchanged execution loop", async () => {
  const f = await baselineFixture({ introduced: true });
  try {
    await failedBaseline(f);
    const result = await f.service.recoverBaseline({ executionId: "EXEC-1" });
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "VERIFY_COMMAND_FAILED");
    assert.equal(f.context.state, "committed");
    const artifact = await f.service.loadArtifact(result.artifact_id);
    assert.equal(artifact.commands.at(-1).disposition, "introduced_failure");
    const count = f.calls.length;
    assert.equal(await f.service.recoverBaseline({ executionId: "EXEC-1" }), null);
    assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});

test("missing recorded environment never falls back to the current workspace", async () => {
  const f = await baselineFixture();
  try {
    const { artifact } = await failedBaseline(f);
    await unlink(resolveRuntimePath(f.root, artifact.environment.manifest_path));
    const count = f.calls.length;
    await assert.rejects(f.service.recoverBaseline({ executionId: "EXEC-1" }), { code: "ENOENT" });
    assert.equal(f.calls.length, count); assert.equal(f.context.state, "committed");
  } finally { await f.close(); }
});

test("stale source, project, plan and acceptance failures never become baseline requests", async () => {
  const f = await baselineFixture();
  try {
    const { artifact } = await failedBaseline(f);
    const options = { taskId: f.context.task_id, projectId: "P", policyVersion: artifact.policy_version };
    for (const patch of [{ project_id: "OTHER" }, { task_id: "OTHER" }, { source_revision: "STALE" }, { base_sha: "OTHER" },
      { manifest_sha: "OTHER" }, { commit_sha: "OTHER" }, { environment: null }, { pre_commit: true },
      { planned_commands: [...artifact.planned_commands].reverse() },
      { commands: artifact.commands.map((command, i) => i === artifact.commands.length - 1 ? { ...command, scope: "ticket" } : command) }]) {
      assert.throws(() => baselineRecoveryRequest({ ...artifact, ...patch }, f.context, options), { code: "VERIFY_BASELINE_RECOVERY_INVALID" });
    }
  } finally { await f.close(); }
});

test("Stop and context replacement during execution prevent verification publication", async () => {
  const f = await baselineFixture();
  try {
    await failedBaseline(f);
    let active = true;
    const original = f.options.runCommand;
    const service = createTicketVerificationService({ ...f.options, runCommand: async input => {
      const output = await original(input); active = false; return output;
    } });
    await assert.rejects(service.recoverBaseline({ executionId: "EXEC-1", assertActive: () => {
      if (!active) throw Object.assign(Error("Stopped"), { code: "VERIFY_RECOVERY_CANCELLED" });
    } }), { code: "VERIFY_RECOVERY_CANCELLED" });
    assert.equal(f.context.state, "committed");
    const changed = createTicketVerificationService({ ...f.options, runCommand: async input => {
      const output = await original(input); f.context.version++; return output;
    } });
    await assert.rejects(changed.recoverBaseline({ executionId: "EXEC-1" }), { code: "VERIFY_BASELINE_RECOVERY_INVALID" });
    assert.equal(f.context.state, "committed");
  } finally { await f.close(); }
});

for (const boundary of ["context", "job"]) test(`restart after artifact publication repairs ${boundary} persistence without rerunning tests`, async () => {
  const f = await baselineFixture();
  try {
    await failedBaseline(f);
    let interrupted = false;
    const broken = createTicketVerificationService({ ...f.options,
      executionContexts: { ...f.options.executionContexts, update: async (...args) => {
        if (!interrupted && boundary === "context") { interrupted = true; throw Object.assign(Error("Simulated context interruption"), { code: "EIO" }); }
        return f.options.executionContexts.update(...args);
      } }, stateFileService: { ...f.files,
      atomicWrite: async input => {
        if (!interrupted && boundary === "job" && input.path.includes("/jobs/VERIFY-BASELINE-")) {
          interrupted = true; throw Object.assign(Error("Simulated persistence interruption"), { code: "EIO" });
        }
        return f.files.atomicWrite(input);
      } } });
    await assert.rejects(broken.recoverBaseline({ executionId: "EXEC-1" }), { code: "EIO" });
    const count = f.calls.length;
    const restarted = createTicketVerificationService(f.options);
    const result = await restarted.recoverBaseline({ executionId: "EXEC-1" });
    assert.equal(result.status, "passed"); assert.equal(f.calls.length, count);
    assert.equal((await restarted.assertPassedArtifact()).artifact_id, result.artifact_id);
    const receipt = JSON.parse(await f.files.readFile({ path: result.evidence_ref }));
    assert.equal(receipt.status, "passed"); assert.equal(receipt.identity.execution_id, "EXEC-1");
  } finally { await f.close(); }
});

test("an unavailable baseline remains unproven and identical failed recovery does not rerun", async () => {
  const f = await baselineFixture();
  try {
    await failedBaseline(f);
    const base = f.context.base_sha;
    await unlink(join(f.root, ".git/objects", base.slice(0, 2), base.slice(2)));
    const result = await f.service.recoverBaseline({ executionId: "EXEC-1" });
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "VERIFY_BASELINE_UNAVAILABLE");
    assert.equal(f.context.state, "committed");
    const artifact = await f.service.loadArtifact(result.artifact_id);
    assert.equal(artifact.commands.at(-1).disposition, "unattributed_failure");
    assert.ok(artifact.commands.at(-1).baseline_error);
    const count = f.calls.length;
    const reused = await createTicketVerificationService(f.options).recoverBaseline({ executionId: "EXEC-1" });
    assert.equal(reused.reused, true); assert.equal(f.calls.length, count);
    await assert.rejects(f.service.recoverBaseline({ executionId: "OTHER" }), { code: "VERIFY_BASELINE_RECOVERY_INVALID" });
  } finally { await f.close(); }
});
