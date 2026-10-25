// Verifies malformed tools and historic read failures do not invent approval denials across ticket recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerFailureClassification, requiresBlockerAdmission, requiresEvidenceReconciliation } from "../../src/modules/supervisor/blocker-failure-classification.js";
import { createBlockerAdmission } from "../../src/modules/supervisor/blocker-execution-admission.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const technical = { tool: "search_text", error: { code: "TOOL_INPUT_INVALID", message: "Invalid search_text arguments." } };
const proposal = { action: "reconciliation_required", reconciliation: { kind: "execution_admission" } };

// Binds test recovery to distinct ticket executions rather than a production-specific ID.
function jobFor(id) {
  return { id, reason_code: "ACCESS_REQUIRED", failure_at: "2026-10-19T15:31:53Z",
    request: { project_id: "P", task_id: id, request_id: `REQ-${id}`, correlation_id: `CORR-${id}`, payload: { execution_id: `RUN-${id}` } } };
}

test("tool input failures on any ticket remain technical and cannot prepare admission", async () => {
  for (const id of ["FIRST", "SECOND"]) {
    const job = jobFor(id);
    const readFailureEvidence = async () => ({ status: "captured", receipts: [technical] });
    job.ticket_progress = { failure_classification: await createBlockerFailureClassification({ readFailureEvidence })(job, { projectRoot: "/project" }) };
    assert.equal(requiresBlockerAdmission(job), false);
    const admission = createBlockerAdmission({ readFailureEvidence, inspect: async () => ({ workspace: { projectRoot: "/project" } }) });
    await assert.rejects(admission.prepare(proposal, job), (error) => {
      assert.equal(error.code, "BLOCKER_DISPOSITION_INVALID");
      assert.equal(error.retryable_disposition, true);
      assert.match(error.message, /technical failures, not an approval denial/);
      return true;
    });
    assert.equal(job.execution_admission, undefined);
  }
});

test("missing receipts and scope failures produce actionable correction without manufacturing approval", async () => {
  for (const evidence of [{ status: "missing", receipts: [] }, { status: "partial", receipts: [] },
    { status: "captured", receipts: [{ tool: "read_file", error: { code: "PATH_FORBIDDEN", message: "Path outside tool scope" } }] }]) {
    const job = jobFor("UNKNOWN");
    const readFailureEvidence = async () => evidence;
    job.ticket_progress = { failure_classification: await createBlockerFailureClassification({ readFailureEvidence })(job, { projectRoot: "/project" }) };
    assert.equal(requiresBlockerAdmission(job), false);
    assert.equal(requiresEvidenceReconciliation(job), true);
    assert.equal(job.ticket_progress.failure_classification.category, "evidence_incomplete");
    const admission = createBlockerAdmission({ readFailureEvidence, inspect: async () => ({ workspace: { projectRoot: "/project" } }) });
    await assert.rejects(admission.prepare(proposal, job), (error) => {
      assert.equal(error.code, "BLOCKER_DISPOSITION_INVALID");
      assert.equal(error.validation_errors[0].reason, "execution_admission_misclassified");
      assert.equal(error.retryable_disposition, true);
      return true;
    });
    assert.equal(job.execution_admission, undefined);
  }
});

test("missing failure receipts require technical investigation, never fabricated access approval or premature resume", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: {
    readFailureEvidence: async () => ({ status: "missing", receipts: [] }) }, investigate: async (job, resolution) => {
    assert.equal(requiresBlockerAdmission(job), false);
    assert.equal(requiresEvidenceReconciliation(job), true);
    return resolution;
  } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.status, "pending");
    assert.equal(job.validation_feedback[0].reason, "failure_evidence_incomplete");
    assert.equal(job.execution_admission, undefined);
    assert.equal(f.base.invocations, 1);
    assert.deepEqual(f.calls, ["sprint_leader"]);
  } finally { await f.close(); }
});

test("coded denials without prose remain protected, including partial evidence and missing path arguments", async () => {
  for (const code of ["APPROVAL_DENIED", "COMMIT_APPROVAL_REJECTED"]) {
  for (const status of ["captured", "partial"]) {
    const job = jobFor("DENIED");
    const readFailureEvidence = async () => ({ status, receipts: [technical, { tool: "run_check", error: { code } }] });
    job.ticket_progress = { failure_classification: await createBlockerFailureClassification({ readFailureEvidence })(job, { projectRoot: "/project" }) };
    assert.equal(requiresBlockerAdmission(job), true);
    const admission = createBlockerAdmission({ readFailureEvidence, inspect: async () => ({ workspace: { projectRoot: "/project" } }) });
    if (status === "partial") await assert.rejects(admission.prepare(proposal, job), { code: "EXECUTION_ADMISSION_EVIDENCE_REQUIRED" });
    else {
      const result = await admission.prepare(proposal, job);
      assert.equal(result.execution_admission_request.receipts.length, 1);
      assert.deepEqual(result.execution_admission_request.source, []);
      await assert.rejects(admission.assertAllowed({ ...job, execution_admission: result.execution_admission_request }), { code: "EXECUTION_ADMISSION_REQUIRED" });
    }
  }
  }
});

test("production correction of invented admission returns to SL then retained Coder without AM or checkpoint reset", async () => {
  let attempts = 0;
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: {
    readFailureEvidence: async () => ({ status: "captured", receipts: [technical] }) }, investigate: async (_job, resolution) =>
    ++attempts === 1 ? { ...resolution, action: "reconciliation_required", reconciliation: { kind: "execution_admission",
      prerequisite: "Assumed approval denial", completed_checks: ["Input was invalid"], next_check: "Find denial receipt" } } : resolution });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].status, "pending");
    assert.equal((await f.ledger()).jobs[0].validation_feedback[0].reason, "execution_admission_misclassified");
    await f.recovery.tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.ledger()).execution_id, "EXEC");
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.ticket_progress.last_completed_turn, checkpoint.last_completed_turn);
  } finally { await f.close(); }
});
