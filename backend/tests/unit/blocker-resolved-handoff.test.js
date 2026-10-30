// Verifies completed reconciliation resumes retained Coder work without treating future checks as blocking research.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker/blocker-technical-reconciliation.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker/blocker-recovery-contract.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker/blocker-validation.js";

const reconciliation = { kind: "source_revision",
  prerequisite: "Recovery design is complete; runtime acceptance follows normal Coder handoff.",
  completed_checks: ["Refreshed current source checksums; approved historical bindings remain unchanged."],
  next_check: "During normal execution obtain the scoped commit and mapped verification evidence.",
  waiting_for: [{ owner: "coder", operation: "execute", question: "After handoff provide commit and acceptance checks; preparation is read-only." }] };
const technical_result = { findings: ["Current commit service accepts whole ticket files; no historical receipt reconstruction is needed.",
  "Source inspection does not prove runtime acceptance."],
implementation_steps: ["Keep existing changes and complete only demonstrated gaps using normal source, claim and execution checks."],
verification_steps: ["Run the mapped integration checks after commit; production acceptance remains separate."],
admission: { status: "within_existing_permissions", rationale: "The original failure is technical; normal tool approval still applies." } };
const resolved = { action: "resolved", reconciliation, technical_result };

test("completed investigation with future Coder execution is valid, with or without remaining execution tasks", () => {
  for (const work of [reconciliation, { ...reconciliation, waiting_for: undefined }]) {
    assert.doesNotThrow(() => validateTechnicalReconciliation({ ...resolved, reconciliation: work }, {}));
  }
});

test("resolved context cannot conceal outstanding inspection, external evidence or unknown ownership", () => {
  const inputs = ["Need permission before execution", { owner: "external", operation: "execute", question: "Approve access" },
    { owner: "architecture_manager", operation: "inspect", question: "Decide the interface" },
    { owner: "coder", operation: "inspect", question: "Compare sources first" }, { owner: "coder", question: "Unclassified work" }];
  for (const input of inputs) assert.throws(() => validateTechnicalReconciliation({ ...resolved,
    reconciliation: { ...reconciliation, waiting_for: [reconciliation.waiting_for[0], input] } }, {}), (error) => {
    assert.equal(error.validation_errors[0].path, "/reconciliation/waiting_for/1");
    assert.equal(error.validation_errors[0].reason, "resolved_prerequisite_pending");
    return true;
  });
});

test("completed reconciliation always requires a full technical result and permitted admission", () => {
  for (const result of [undefined, { ...technical_result, verification_steps: [] },
    ...["denied", "unresolved"].map((status) => ({ ...technical_result, admission: { status, rationale: "A real boundary remains." } }))]) {
    assert.throws(() => validateTechnicalReconciliation({ ...resolved, technical_result: result }, {}), { code: "BLOCKER_DISPOSITION_INVALID" });
  }
});

test("historical checksum cannot stand in for current source when resolving technical recovery", async () => {
  const f = await blockerRecoveryFixture();
  try {
    const value = { ...f.resolution, ...resolved, evidence: [{ ...f.evidence, sha256: "a".repeat(64) }] };
    await assert.rejects(validateBlockerDisposition(value, { job: { stage: "sprint_leader", request: { ticket: f.ticket } },
      plan: { content: {} }, fileService: f.base.fileService, projectRoot: f.base.workspace.projectRoot }),
    (error) => error.validation_errors[0].reason === "evidence_stale");
  } finally { await f.close(); }
});

test("retained corrected response crosses validation, admission and resume without another provider survey", async () => {
  let corrected = false;
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED",
    recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [
      { event_id: "ORIGINAL", tool: "commit_changes", error: { code: "TICKET_BASELINE_CONFLICT", message: "Historical parent mismatch" } }
    ] }) }, investigate: async (_job, resolution) => ({ ...resolution, ...resolved,
      evidence: corrected ? resolution.evidence : [{ ...resolution.evidence[0], sha256: "a".repeat(64) }] }) });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    const ledger = await f.ledger();
    const job = ledger.jobs.at(-1);
    assert.equal(job.validation_feedback[0].reason, "evidence_stale");
    // Models a persisted response rejected by the previous action-only validator, leaving its audit intact.
    const retained = { ...f.resolution, ...resolved };
    job.disposition_attempts.at(-1).response = blockerResponseEvidence(retained);
    job.disposition_attempts.at(-1).validation_errors = [{ path: "/action", reason: "reconciliation_action_mismatch" }];
    job.status = "reconciliation_required";
    job.outcome_reason = "disposition_correction_no_progress";
    await f.base.store.save("blocker.recovery", ledger);
    const parked = await f.base.checkpoints.load("TASK");
    await f.base.checkpoints.save({ ...parked, phase: "blocker_reconciliation_required",
      blocker_recovery: { job_id: job.id, status: "reconciliation_required", reason: job.outcome_reason } });
    corrected = true;
    f.advance(10);
    f.recreate();
    const resumed = await f.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed_stage, "sprint_leader");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).status, "resume_pending");
    assert.deepEqual(f.calls, ["sprint_leader"]);
    await f.recreate().tick();
    const final = (await f.ledger()).jobs.at(-1);
    const checkpoint = await f.base.checkpoints.load("TASK");
    assert.equal(final.status, "resumed");
    assert.equal(f.base.invocations, 2);
    assert.equal(f.base.integrations, 1);
    assert.equal(checkpoint.blocker_recovery.ticket_progress.last_completed_turn, before.last_completed_turn);
    assert.equal(f.base.statusStore.get().details.execution_id, "EXEC");
    assert.deepEqual(checkpoint.blocker_recovery.disposition.reconciliation, reconciliation);
    assert.equal(checkpoint.blocker_recovery.ticket_progress.failure_classification.category, "technical_failure");
  } finally { await f.close(); }
});

test("a real access denial cannot use completed-context metadata to obtain a Sprint resume", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED",
    recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [
      { event_id: "DENIAL", tool: "edit_diff", error: { code: "ACCESS_DENIED", message: "Approval denied" } }
    ] }) }, investigate: async (_job, resolution) => ({ ...resolution, ...resolved }) });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs.at(-1).validation_feedback[0].reason, "access_or_security_authority_required");
    assert.equal(f.base.invocations, 1);
    assert.equal(f.base.integrations, 0);
  } finally { await f.close(); }
});
