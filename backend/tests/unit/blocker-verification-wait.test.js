// Prevents duplicate external verification waits while preserving real missing dependencies and execution gates.
import assert from "node:assert/strict";
import test from "node:test";
import { assertVerificationWait, verificationDecisionPrompt } from "../../src/modules/supervisor/blocker-verification-wait.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Supplies current terminal facts and independent external requests for generic ticket recovery.
function fixture(status = "failed") {
  const job = { ticket_progress: { failure_classification: { category: "technical_failure" }, verification: { status: "observed",
    job: { job_id: "VERIFY-ONE", status, artifact_id: "ARTIFACT-ONE" }, diagnostic: { reason: "VERIFY_COMMAND_FAILED", commands: [{ exit_code: 1, stderr_redacted: "Missing module" }] },
    checks: [{ check_id: "CHECK-ONE", status: "failed", exit_code: 1 }], source_composition: { files: [{ path: "backend/dependency.js", committed: false }] } } } };
  const value = { action: "reconciliation_required", reconciliation: { waiting_for: [{ owner: "external", operation: "inspect", question: "Supply terminal status for VERIFY-ONE." }] } };
  return { job, value };
}

test("terminal job waits and supplied focused diagnostics get actionable automatic correction", () => {
  for (const question of ["Supply terminal status for VERIFY-ONE.", "Supply diagnostic output for CHECK-ONE.", "Supply archived manifest composition for backend/dependency.js in CHECK-ONE.", "Cho kết quả VERIFY-ONE."]) {
    const { job, value } = fixture(); value.reconciliation.waiting_for[0].question = question;
    assert.throws(() => assertVerificationWait(value, job), (error) => {
      assert.equal(error.code, "BLOCKER_DISPOSITION_INVALID"); assert.equal(error.retryable_disposition, true);
      assert.equal(error.validation_errors[0].reason, "verification_evidence_already_supplied");
      assert.equal(error.validation_errors[0].path, "/reconciliation/waiting_for/0");
      assert(error.validation_errors[0].expected);
      return true;
    });
  }
});

test("pending, unknown, other records and actual executable dependency requests remain distinct", () => {
  const { job, value } = fixture("running"); assert.doesNotThrow(() => assertVerificationWait(value, job));
  for (const question of ["Supply terminal result for VERIFY-OTHER.", "Supply owner authorization for VERIFY-ONE.", "Integrate the missing dependency as a committed upstream source."]) {
    const f = fixture(); f.value.reconciliation.waiting_for[0].question = question;
    assert.doesNotThrow(() => assertVerificationWait(f.value, f.job));
  }
  const f = fixture(); f.value.reconciliation.waiting_for[0].operation = "execute";
  assert.doesNotThrow(() => assertVerificationWait(f.value, f.job));
  delete f.job.ticket_progress.verification; assert.doesNotThrow(() => assertVerificationWait(value, f.job));
});

test("current decision prompt distinguishes terminal source defects from historical pending claims", () => {
  const { job } = fixture(); const prompt = verificationDecisionPrompt(job);
  assert.match(prompt, /"status":"failed"/); assert.match(prompt, /supersede historical/);
  assert.match(prompt, /captured separately by Node/); assert.match(prompt, /not an unrelated dependency commit/);
  assert.match(prompt, /Missing module/);
});

test("production validation rejects a stale external wait and SL corrects it before any Coder resume", async () => {
  let f; let decisions = 0;
  f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => {
    decisions++;
    if (decisions === 1) return { action: "reconciliation_required", summary: "Waiting for an old pending job.", guidance: "Read the current terminal result.",
      reconciliation: { kind: "tooling", prerequisite: "Supply verification status.", completed_checks: ["Inspected unchanged source."], next_check: "Read verification receipt.",
        waiting_for: [{ owner: "external", operation: "inspect", question: "Supply terminal status for VERIFY-ONE." }] } };
    return resolution;
  } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const authorityJob = (await f.ledger()).jobs[0];
    const context = await f.base.workspace.executionContexts.load("TASK");
    await f.base.fileService.atomicWrite({ path: ".forge/runtime/ticket-verification/TASK/jobs/VERIFY-ONE.json", content: JSON.stringify({
      job_id: "VERIFY-ONE", task_id: "TASK", status: "failed", attempt: 1, commit_sha: context.review_commit_sha, source_revision: context.source_revision,
      error: { code: "VERIFY_COMMAND_FAILED" } }), replace: false });
    await f.recovery.tick();
    let saved = (await f.ledger()).jobs[0];
    assert.equal(saved.status, "pending");
    assert.equal(saved.validation_feedback[0].reason, "verification_evidence_already_supplied");
    assert.equal(f.base.invocations, 1);
    await f.recreate().tick();
    saved = (await f.ledger()).jobs[0];
    assert.equal(saved.status, "resume_pending");
    assert.deepEqual(f.calls, ["sprint_leader", "sprint_leader"]);
    assert.equal(f.base.invocations, 1);
    assert.equal(saved.request.payload.execution_id, authorityJob.request.payload.execution_id);
    await assert.rejects(validateBlockerDisposition({ action: "reconciliation_required", summary: "Still waiting", guidance: "Supply record",
      reconciliation: { kind: "tooling", prerequisite: "Missing", completed_checks: ["Inspected"], next_check: "Supply", waiting_for: ["Supply terminal result for VERIFY-ONE"] } },
    { job: { ...authorityJob, ticket_progress: fixture().job.ticket_progress } }), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await f.close(); }
});

// Confirms SDK providers receive authoritative runtime facts after stale failure and historical messages.
test("actual recovery SDK prompt ends with current terminal facts after historical pending messages", async () => {
  const f = await blockerRecoveryFixture();
  try {
    const worker = createBlockerRecoveryAgent({ readFailureEvidence: async () => ({ status: "missing", receipts: [] }),
      agentResolver: { resolveAvailable: () => ({ agent_id: "SL", role: "sprint_leader", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} }, resolveTicketWorkspace: async () => f.base.workspace,
      gateways: { openaiSdkGateway: { execute: async ({ prompt }) => {
        assert(prompt.lastIndexOf("CURRENT NODE VERIFICATION FACTS") > prompt.indexOf("HISTORICAL-PENDING"));
        assert.match(prompt.slice(prompt.lastIndexOf("CURRENT NODE VERIFICATION FACTS")), /"status":"failed"/);
        return { text: JSON.stringify(f.resolution) };
      } } }
    });
    await worker({ id: "J", stage: "sprint_leader", ...fixture().job, request: { task_id: "TASK", ticket: f.ticket },
      history: [{ summary: "HISTORICAL-PENDING VERIFY-ONE still running" }] }, { deadline: Date.now() + 5000 });
  } finally { await f.close(); }
});

// Corrects every supplied-record wait in one response rather than rediscovering each duplicate separately.
test("one correction identifies all duplicate verification waits", () => {
  const { job, value } = fixture();
  value.reconciliation.waiting_for.push({ owner: "external", question: "Supply diagnostic output for CHECK-ONE." });
  assert.throws(() => assertVerificationWait(value, job), (error) => {
    assert.equal(error.validation_errors.length, 2);
    assert.deepEqual(error.validation_errors.map((entry) => entry.path), ["/reconciliation/waiting_for/0", "/reconciliation/waiting_for/1"]);
    return true;
  });
});

// A committed, validated dependency revision clears the corresponding integration-record wait without granting tool permission.
test("ready integrated dependency evidence rejects only the same supplied revision request", () => {
  const f = fixture();
  f.job.ticket_progress.verification.source_composition.integrated_source = { status: "ready", commit_sha: "SOURCE", added_paths: ["backend/dependency.js"] };
  f.value.reconciliation.kind = "dependency";
  f.value.reconciliation.waiting_for[0].question = "Integration maintainer: supply a committed integration revision for backend/dependency.js.";
  assert.throws(() => assertVerificationWait(f.value, f.job), { code: "BLOCKER_DISPOSITION_INVALID" });
  f.value.reconciliation.waiting_for[0].question = "Integration maintainer: supply a committed integration revision for backend/other.js.";
  assert.doesNotThrow(() => assertVerificationWait(f.value, f.job));
});
