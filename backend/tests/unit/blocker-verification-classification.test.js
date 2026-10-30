// Keeps evidence-backed verification recovery at Sprint scope without letting narrative labels override contract authority.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerFailureClassification, requiresBlockerContract } from "../../src/modules/supervisor/blocker/blocker-failure-classification.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker/blocker-recovery-contract.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Builds an execution-bound failed verification receipt independently of any agent-authored explanation.
function fixture(id = "FIRST") {
  const context = { project_id: "P", task_id: id, source_revision: "REV", base_sha: "BASE", manifest_sha: "MANIFEST", review_commit_sha: "COMMIT" };
  const job = { id: `JOB-${id}`, reason_code: "CONTRACT_DECISION_REQUIRED", failure_at: "2026-10-22T21:10:24Z", stage: "sprint_leader",
    request: { task_id: id, project_id: "P", execution_context: context, ticket: {}, payload: { execution_id: `EXEC-${id}` } } };
  const evidence = { status: "observed", job: { job_id: "VERIFY-A", artifact_id: "ARTIFACT-A", status: "failed",
    error: { code: "VERIFY_COMMAND_FAILED" }, finished_at: "2026-10-22T21:10:00Z" },
  diagnostic: { job_id: "VERIFY-A", artifact_id: "ARTIFACT-A", commands: [
    { blocking: true, exit_code: 1, stdout_redacted: "ENOENT: mkdtemp '.forge/runtime/fixture-123'" }
  ] } };
  const classify = createBlockerFailureClassification({ readVerificationEvidence: async () => evidence });
  const workspace = { projectRoot: "/project", executionContexts: { load: async () => context } };
  return { context, job, evidence, classify, workspace };
}

test("different tickets classify verified setup failures without rewriting their historical contract label", async () => {
  for (const id of ["FIRST", "SECOND"]) {
    const f = fixture(id);
    f.job.ticket_progress = { failure_classification: await f.classify(f.job, f.workspace) };
    assert.equal(f.job.ticket_progress.failure_classification.effective_reason_code, "VERIFY_ENVIRONMENT_INVALID");
    assert.equal(f.job.reason_code, "CONTRACT_DECISION_REQUIRED");
    assert.equal(requiresBlockerContract(f.job), false);
    assert.equal(requiresBlockerContract({ ...f.job, failure_at: "2026-10-22T22:00:00Z" }), true);
    assert.equal(requiresBlockerContract({ ...f.job, request: { ...f.job.request, task_id: "OTHER" } }), true);
    f.evidence.diagnostic.commands[0].stdout_redacted = "ERR_ASSERTION: expected different value";
    const classification = await f.classify(f.job, f.workspace);
    assert.equal(classification.effective_reason_code, "VERIFY_ATTRIBUTION_REQUIRED");
  }
});

test("missing, stale, future, mismatched receipts and explicit contract requirements remain gated", async () => {
  for (const change of [
    (f) => { f.evidence.status = "missing"; },
    (f) => { f.job.request.execution_context = { ...f.context, source_revision: "OLD" }; },
    (f) => { f.evidence.job.finished_at = "2026-10-22T22:00:00Z"; },
    (f) => { f.evidence.job.finished_at = undefined; },
    (f) => { f.evidence.diagnostic.artifact_id = "OTHER"; },
    (f) => { f.evidence.job.status = "passed"; },
    (f) => { f.evidence.diagnostic.commands[0].blocking = false; },
    (f) => { f.job.execution_admission = { decision: "deny" }; },
    (f) => { f.job.request.ticket.execution_policy = { contract_evidence: [{ path: "backend/router.js" }] }; }
  ]) {
    const f = fixture(); change(f);
    const classification = await f.classify(f.job, f.workspace);
    assert.equal(classification, null);
    f.job.ticket_progress = { failure_classification: classification };
    assert.equal(requiresBlockerContract(f.job), true);
  }
});

test("SL validation accepts a verified technical handoff while the same response cannot clear an unknown contract blocker", async () => {
  const runtime = await blockerRecoveryFixture();
  try {
    const f = fixture();
    f.job.request.ticket = runtime.ticket;
    f.job.ticket_progress = { failure_classification: await f.classify(f.job, f.workspace) };
    const options = { job: f.job, plan: {}, fileService: runtime.base.fileService, projectRoot: runtime.base.workspace.projectRoot };
    assert.equal((await validateBlockerDisposition(runtime.resolution, options)).action, "resolved");
    delete f.job.ticket_progress.failure_classification;
    await assert.rejects(() => validateBlockerDisposition(runtime.resolution, options), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await runtime.close(); }
});

test("a recovered passed artifact returns the retained checkpoint to report delivery without another contract decision", async () => {
  const f = fixture();
  f.context.state = "verified";
  f.context.verification_artifact_id = "ARTIFACT-A";
  f.evidence.job.status = "passed";
  f.evidence.diagnostic = null;
  f.job.ticket_progress = { failure_classification: await f.classify(f.job, f.workspace) };
  assert.equal(f.job.ticket_progress.failure_classification.effective_reason_code, "VERIFY_RECOVERY_READY");
  assert.equal(requiresBlockerContract(f.job), false);
  f.context.verification_artifact_id = "ARTIFACT-OTHER";
  assert.equal(await f.classify(f.job, f.workspace), null);
});
