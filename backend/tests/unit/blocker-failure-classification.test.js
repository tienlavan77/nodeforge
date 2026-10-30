// Verifies technical receipt classification removes stale access escalation while real denials and missing evidence stay protected.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerFailureClassification, requiresBlockerAdmission } from "../../src/modules/supervisor/blocker/blocker-failure-classification.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const receipt = { event_id: "TECHNICAL", tool: "commit_changes", error: { code: "TICKET_BASELINE_CONFLICT", message: "Parent differs from before-state." } };

// Keeps immutable report delivery errors in technical recovery without weakening genuine access denials.
test("completed report conflicts are technical for multiple tickets while mixed denials retain admission", async () => {
  const conflicts = ["TOOL_INPUT_INVALID", "CODER_REPORT_CONFLICT", "CODER_REPORT_CONFLICT"].map((code) => ({
    event_id: code, tool: "report_done", error: { code, message: "Completed report field conflicts with the stored value." }
  }));
  for (const id of ["FIRST", "SECOND"]) {
    for (const denial of [null, { code: "APPROVAL_DENIED", message: "Approval denied" },
      { code: "CODER_REPORT_CONFLICT", message: "Permission denied for this operation" }]) {
      const job = jobFixture(id);
      const classify = createBlockerFailureClassification({ readFailureEvidence: async () => ({ status: "captured",
        receipts: [...conflicts, ...(denial ? [{ event_id: "DENIAL", tool: "report_done", error: denial }] : [])] }) });
      job.ticket_progress = { failure_classification: await classify(job, { projectRoot: "/project" }) };
      assert.equal(requiresBlockerAdmission(job), Boolean(denial));
      assert.equal(job.ticket_progress.failure_classification.category, denial ? "access_or_unknown" : "technical_failure");
    }
  }
});

// Supplies independent original failure identities for generic ticket classification tests.
function jobFixture(taskId = "T") {
  return { id: `JOB-${taskId}`, reason_code: "ACCESS_REQUIRED", failure_at: "2026-10-19T06:00:00Z",
    request: { project_id: "P", task_id: taskId, request_id: "R", correlation_id: "C", payload: { execution_id: `EXEC-${taskId}` }, execution_context: { source_revision: "REV" } } };
}

test("complete technical receipts let SL coordinate different tickets without rewriting original access labels", async () => {
  const classify = createBlockerFailureClassification({ readFailureEvidence: async () => ({ status: "captured", receipts: [receipt] }) });
  for (const id of ["FIRST", "SECOND"]) {
    const job = jobFixture(id);
    job.ticket_progress = { failure_classification: await classify(job, { projectRoot: "/project" }) };
    assert.equal(job.reason_code, "ACCESS_REQUIRED");
    assert.equal(job.ticket_progress.failure_classification.category, "technical_failure");
    assert.equal(requiresBlockerAdmission(job), false);
    assert.equal(requiresBlockerAdmission({ ...job, request: { ...job.request, task_id: "OTHER" } }), true);
    assert.equal(requiresBlockerAdmission({ ...job, failure_at: "2026-10-19T07:00:00Z" }), true);
    assert.equal(requiresBlockerAdmission({ ...job, execution_admission: { decision: { verdict: "deny" } } }), true);
    assert.equal(requiresBlockerAdmission({ ...job, reason_code: "SECURITY_RISK" }), true);
  }
});

test("partial evidence is technical reconciliation, while mixed denial retains admission", async () => {
  const denied = { event_id: "DENIED", tool: "edit_diff", error: { code: "APPROVAL_DENIED", message: "Approval denied" } };
  for (const evidence of [
    { status: "partial", receipts: [receipt] }, { status: "missing", receipts: [] },
    { status: "captured", receipts: [receipt, denied] },
    { status: "captured", receipts: [{ ...receipt, error: { code: "UNKNOWN", message: "Unknown operation failure" } }] },
    { status: "captured", receipts: [{ ...receipt, error: { code: "APPROVAL_DENIED", message: "Approval denied; must not attempt workaround" } }] },
    { status: "captured", receipts: [{ tool: "report_done", error: { code: "CODER_BLOCKED" } }] }
  ]) {
    const job = jobFixture();
    const classify = createBlockerFailureClassification({ readFailureEvidence: async () => evidence });
    job.ticket_progress = { failure_classification: await classify(job, { projectRoot: "/project" }) };
    const denial = evidence.receipts.some((entry) => entry.error?.code === "APPROVAL_DENIED");
    assert.equal(requiresBlockerAdmission(job), denial);
    assert.equal(job.ticket_progress.failure_classification.category, denial ? "access_or_unknown" : "evidence_incomplete");
    assert.equal(job.ticket_progress.failure_classification.requires_evidence_reconciliation, !denial);
  }
});

test("storage errors propagate instead of clearing an access requirement", async () => {
  const classify = createBlockerFailureClassification({ readFailureEvidence: async () => { throw new Error("Storage unavailable"); } });
  await assert.rejects(classify(jobFixture(), { projectRoot: "/project" }), /Storage unavailable/);
});

test("production recovery resumes retained Coder directly for an evidenced technical failure, with no AM launch", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED",
    recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [receipt] }) },
    investigate: async (job, resolution) => {
      assert.equal(job.ticket_progress.failure_classification.category, "technical_failure");
      assert.equal(requiresBlockerAdmission(job), false);
      return resolution;
    } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].status, "resume_pending");
    await f.recreate().tick();
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.ledger()).execution_id, "EXEC");
    assert.equal((await f.ledger()).jobs[0].reason_code, "ACCESS_REQUIRED");
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.ticket_progress.failure_classification.category, "technical_failure");
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.ticket_progress.last_completed_turn, before.last_completed_turn);
  } finally { await f.close(); }
});

test("production recovery cannot resolve an actual access denial at Sprint scope", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED",
    recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [{ ...receipt,
      error: { code: "APPROVAL_DENIED", message: "Approval denied" } }] }) },
    investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.validation_feedback[0].reason, "access_or_security_authority_required");
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});

test("Resume reconsiders an obsolete retained AM request when Node's failure classification has changed", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED",
    recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [receipt] }) },
    investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger();
      ledger.jobs[0].disposition_attempts = [{ stage: "sprint_leader", status: "rejected",
        response: { text: JSON.stringify({ action: "architecture_required", summary: "Old access classification required an AM answer." }) } }];
      await f.base.store.save("blocker.recovery", ledger);
    });
    await f.recreate().resumeTicket({ projectId: "P", ticketId: "TASK" });
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal((await f.ledger()).jobs[0].status, "resume_pending");
    await f.recovery.tick();
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.ledger()).execution_id, "EXEC");
  } finally { await f.close(); }
});

// Ensures unavailable legacy polling instructions never turn ordinary verification into a permission denial.
test("verification pending and repeated-read receipts are technical recovery while real denials remain gated", async () => {
  const receipts = ["VERIFY_RECOVERY_PENDING", "READ_REPEATED", "VERIFY_COMMAND_FAILED"].map((code) => ({
    event_id: code, tool: code === "READ_REPEATED" ? "read_file" : "report_done", error: { code, message: "Node-owned verification diagnostic." }
  }));
  for (const denied of [false, true]) {
    const job = jobFixture();
    const classify = createBlockerFailureClassification({ readFailureEvidence: async () => ({ status: "captured",
      receipts: [...receipts, ...(denied ? [{ tool: "edit_diff", error: { code: "APPROVAL_DENIED", message: "Approval denied" } }] : [])] }) });
    job.ticket_progress = { failure_classification: await classify(job, { projectRoot: "/project" }) };
    assert.equal(requiresBlockerAdmission(job), denied);
    assert.equal(job.ticket_progress.failure_classification.category, denied ? "access_or_unknown" : "technical_failure");
  }
});
