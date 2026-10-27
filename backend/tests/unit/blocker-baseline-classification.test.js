/** Exercises the historical ACCESS_REQUIRED label after real verification
 * recovery. Typed source-bound receipts clear technical blockers without treating
 * passing tests as permission to bypass an independent denial or missing evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerFailureClassification, requiresBlockerAdmission, requiresEvidenceReconciliation, refreshBlockerFailureFeedback } from "../../src/modules/supervisor/blocker-failure-classification.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

/** Reproduces the mixed legacy input-validation and baseline receipts seen in production. */
function originalReceipts() {
  return ["TOOL_INPUT_INVALID", "RG_SEARCH_INPUT_INVALID", "VERIFY_BASELINE_UNAVAILABLE", "TOOL_INPUT_INVALID"].map((code, index) =>
    ({ event_id: `EVENT-${index}`, tool: index < 2 ? "search_text" : "report_done", error: { code, message: "Structured technical failure." } }));
}

/** Supplies independently issued verification and artifact identities for any ticket. */
function fixture(taskId = "FIRST") {
  const context = { task_id: taskId, project_id: "P", version: 2, state: "verified", verification_artifact_id: "ARTIFACT-RECOVERY",
    source_revision: "REV", manifest_sha: "MANIFEST", base_sha: "BASE", review_commit_sha: "COMMIT" };
  const job = { id: `JOB-${taskId}`, reason_code: "ACCESS_REQUIRED", failure_at: "2026-10-27T00:00:00Z", stage: "sprint_leader",
    request: { task_id: taskId, project_id: "P", payload: { execution_id: `EXEC-${taskId}` }, execution_context: { ...context } } };
  const evidence = { status: "captured", receipts: originalReceipts() };
  const verification = { status: "observed", source_revision: "REV", commit_sha: "COMMIT",
    job: { job_id: "VERIFY-RECOVERY", artifact_id: "ARTIFACT-RECOVERY", status: "passed" } };
  const artifact = { task_id: taskId, project_id: "P", status: "passed", artifact_id: "ARTIFACT-RECOVERY", commit_sha: "COMMIT",
    source_revision: "REV", manifest_sha: "MANIFEST", base_sha: "BASE" };
  const workspace = { projectRoot: "/project", executionContexts: { load: async () => ({ ...context }) },
    testService: { assertPassedArtifact: async () => artifact } };
  const classify = createBlockerFailureClassification({ readFailureEvidence: async () => evidence, readVerificationEvidence: async () => verification });
  return { context, job, evidence, verification, artifact, workspace, classify };
}

test("completed baseline verification clears the stale access classification for different tickets", async () => {
  for (const id of ["FIRST", "SECOND"]) {
    const f = fixture(id);
    const classification = await f.classify(f.job, f.workspace);
    f.job.ticket_progress = { failure_classification: classification };
    assert.equal(classification.category, "technical_failure");
    assert.equal(classification.effective_reason_code, "VERIFY_RECOVERY_READY");
    assert.equal(classification.artifact_id, f.artifact.artifact_id);
    assert.equal(classification.requires_evidence_reconciliation, false);
    assert.equal(requiresEvidenceReconciliation(f.job), false); assert.equal(requiresBlockerAdmission(f.job), false);
    assert.equal(f.job.reason_code, "ACCESS_REQUIRED");
  }
});

test("baseline and legacy search errors remain technical while verification is incomplete", async () => {
  const f = fixture(); f.context.state = "committed";
  const classification = await f.classify(f.job, f.workspace);
  assert.equal(classification.category, "technical_failure");
  assert.equal(classification.effective_reason_code, undefined);
});

test("passing tests do not clear partial, unknown or genuinely denied operations", async () => {
  for (const kind of ["partial", "missing", "unknown", "denied", "permission", "admission"]) {
    const f = fixture();
    if (["partial", "missing"].includes(kind)) f.evidence.status = kind;
    if (kind === "unknown") f.evidence.receipts.push({ tool: "edit_diff", error: { code: "UNKNOWN_FAILURE" } });
    if (kind === "denied") f.evidence.receipts.push({ tool: "edit_diff", error: { code: "APPROVAL_DENIED" } });
    if (kind === "permission") f.evidence.receipts[0].error.message = "Permission denied for this operation";
    if (kind === "admission") f.job.execution_admission = { status: "pending", decision: { verdict: "deny" } };
    const classification = await f.classify(f.job, f.workspace);
    f.job.ticket_progress = { failure_classification: classification };
    assert.notEqual(classification.category, "technical_failure", kind);
    assert.equal(classification.effective_reason_code, undefined, kind);
    assert.equal(requiresBlockerAdmission(f.job), ["denied", "permission", "admission"].includes(kind), kind);
  }
});

test("current verification and artifact must match every retained source identity", async () => {
  const mutations = [
    f => { f.context.task_id = "OTHER"; }, f => { f.context.project_id = "OTHER"; },
    ...["source_revision", "manifest_sha", "base_sha", "review_commit_sha"].map(key => f => { f.context[key] = "OTHER"; }),
    f => { f.verification.status = "missing"; }, f => { f.verification.job.status = "failed"; },
    f => { f.verification.commit_sha = "OTHER"; }, f => { f.verification.source_revision = "OTHER"; },
    f => { f.verification.job.artifact_id = "OTHER"; }, f => { f.artifact.pre_commit = true; },
    f => { f.artifact.baseline_recovery = { execution_id: "OTHER" }; },
    ...["task_id", "project_id", "source_revision", "manifest_sha", "base_sha", "commit_sha", "artifact_id", "status"].map(key => f => { f.artifact[key] = "OTHER"; }),
    f => { f.workspace.testService.assertPassedArtifact = async () => { f.context.version++; return f.artifact; }; },
    f => { f.workspace.testService.assertPassedArtifact = async () => { throw Object.assign(Error("Missing policy coverage"), { code: "VERIFY_ARTIFACT_MISMATCH" }); }; }
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const classification = await f.classify(f.job, f.workspace);
    assert.notEqual(classification.effective_reason_code, "VERIFY_RECOVERY_READY");
  }
});

test("storage faults remain visible instead of fabricating verification readiness", async () => {
  const f = fixture();
  f.workspace.testService.assertPassedArtifact = async () => { throw Object.assign(Error("Storage unavailable"), { code: "EIO" }); };
  await assert.rejects(f.classify(f.job, f.workspace), { code: "EIO" });
});

test("fresh technical classification removes obsolete evidence-gap feedback without dropping independent errors", async () => {
  const f = fixture();
  const classification = await f.classify(f.job, f.workspace);
  f.job.validation_feedback = [{ path: "/action", reason: "failure_evidence_incomplete" }, { path: "/evidence", reason: "source_changed" }];
  assert.equal(refreshBlockerFailureFeedback(f.job, classification), true);
  assert.deepEqual(f.job.validation_feedback, [{ path: "/evidence", reason: "source_changed" }]);
  f.job.validation_feedback.push({ path: "/action", reason: "failure_evidence_incomplete" });
  assert.equal(refreshBlockerFailureFeedback(f.job, { ...classification, binding: "FOREIGN" }), false);
  f.job.execution_admission = { status: "pending", decision: { verdict: "deny" } };
  assert.equal(refreshBlockerFailureFeedback(f.job, classification), false);
});

test("production SL handoff resumes Coder at its saved turn after mixed baseline receipts, without AM or another SL investigation", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED",
    recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: originalReceipts() }) },
    investigate: async (job, resolution) => {
      assert.equal(job.ticket_progress.failure_classification.category, "technical_failure");
      assert.equal(job.validation_feedback, undefined);
      assert.equal(job.last_error, undefined);
      return resolution;
    } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.base.checkpoints.save({ ...before, last_completed_turn: 43, thread_id: "RETAINED" });
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger();
      Object.assign(ledger.jobs[0], { validation_feedback: [{ path: "/action", reason: "failure_evidence_incomplete" }],
        last_error: "Obsolete evidence gap" });
      await f.base.store.save("blocker.recovery", ledger);
    });
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].status, "resume_pending");
    await f.recreate().tick();
    assert.equal((await f.ledger()).jobs[0].status, "resumed");
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 43);
    assert.equal((await f.base.checkpoints.load("TASK")).thread_id, "RETAINED");
  } finally { await f.close(); }
});
