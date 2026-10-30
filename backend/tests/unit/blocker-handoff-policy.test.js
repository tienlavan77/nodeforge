/** Verifies that AM decisions become actionable SL/Coder handoffs without a
 * second Node admission workflow, including recovery of existing parked jobs.
 * Immutable evidence, explicit Owner decisions and execution cancellation remain intact. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { retainBlockerContract } from "../../src/modules/supervisor/blocker/blocker-contract-evidence.js";
import { blockerHandoffPrompt, completeBlockerAdmissionWait, blockerHandoffCorrection, createBlockerHandoffRefresh } from "../../src/modules/supervisor/blocker/blocker-handoff-policy.js";
import { returnArchitectureResponse } from "../../src/modules/supervisor/blocker/blocker-architecture-response.js";
import { admissionPrompt } from "../../src/modules/supervisor/blocker/blocker-execution-admission.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket/ticket-resume.js";

const basis = { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) };
const quote = "Preserve existing security restrictions and complete the approved source implementation.";
const technical = { tool: "edit_diff", error: { code: "TICKET_SOURCE_CHANGED" } };
const assessment = { rationale: "Implementation stays within the existing plan.", changes_structure: false, changes_owner_scope: false,
  changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false };

/** Creates a real persisted AM answer and a legacy SL admission-validation stop,
 * using production dispatch services so the recovery must retain checkpoint 96. */
async function fixture(t, receipt = technical) {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", investigate: async (job, resolution) => {
    assert.match(job.coordination_feedback, /no separate Node admission step/i);
    assert.equal(job.ticket_progress.architecture_decision.action, "resolved");
    return resolution;
  }, recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [receipt] }),
    architecturePlans: { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "approved.md", markdown: quote }) } } });
  t.after(f.close);
  const ready = f.base.registry.assertReady;
  f.base.registry.assertReady = async (...args) => {
    const result = await ready(...args);
    return { ...result, plan: { ...result.plan, proposal_id: `${basis.plan_id}-R1-${basis.sha256}`, source_path: "approved.md", source_sha256: basis.sha256 } };
  };
  await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
  const ledger = await f.ledger(), job = ledger.jobs[0];
  const decision = { action: "resolved", authority_scope: "architecture", architecture_basis: basis, authority_quote: quote,
    summary: "Continue the implementation within the approved plan.", boundary_assessment: assessment, evidence: [f.evidence],
    guidance: "Keep real tool boundaries; complete the remaining permitted implementation and focused checks.",
    technical_result: { findings: ["Existing scope is unchanged."], implementation_steps: ["Complete only the remaining implementation."],
      verification_steps: ["Run the mapped focused checks."], admission: { status: "within_existing_permissions", rationale: "The approved plan covers this implementation." } } };
  const saved = await f.base.checkpoints.load("TASK");
  const receipts = await retainBlockerContract({ fileService: f.base.fileService, checkpoint: saved, job: { ...job,
    history: [{ stage: "architecture_manager", completed_at: 1000, actor: { agent_id: "AM", role: "architecture_manager" }, disposition: decision }] } });
  await f.base.checkpoints.save({ ...saved, contract_decisions: receipts, last_completed_turn: 96, thread_id: "PRESERVED" });
  Object.assign(job, { status: "reconciliation_required", stage: "sprint_leader", outcome_reason: "disposition_correction_no_progress",
    validation_feedback: [{ path: "/reconciliation/kind", reason: "execution_admission_misclassified" }],
    execution_admission: { status: "awaiting_architecture_review", receipts: [{ event_id: "ORIGINAL", tool: "edit_diff", error: { code: "APPROVAL_DENIED" } }] } });
  await f.base.store.save("blocker.recovery", ledger);
  return { f, job, receipts, decision };
}

test("validated AM answer returns to SL and archives the pending request without granting tool approval", () => {
  const original = { status: "awaiting_architecture_review", receipts: [{ event_id: "DENIED" }] };
  const job = { stage: "architecture_manager", history: [], request: { payload: { execution_id: "E" } }, execution_admission: original };
  assert.equal(returnArchitectureResponse(job, { action: "resolved", authority_scope: "architecture" }, 1000), true);
  assert.equal(job.stage, "sprint_leader");
  assert.equal(job.status, "pending");
  assert.equal(job.execution_admission.status, "retained_for_audit");
  assert.equal(job.execution_admission.decision, undefined);
  assert.deepEqual(job.execution_admission.receipts, original.receipts);
  assert.equal(original.status, "awaiting_architecture_review");
});

test("explicit Owner verdicts are not changed when retiring an internal admission wait", () => {
  for (const verdict of ["allow", "deny"]) {
    const request = { status: `owner_${verdict}`, decision: { verdict, actor: "OWNER" } };
    const job = { history: [], execution_admission: request };
    completeBlockerAdmissionWait(job, 1000);
    assert.equal(job.execution_admission, request);
    assert.equal(job.history.length, 0);
  }
});

test("resumed Coder receives an explicit current policy rather than another request to wait for Node", () => {
  const checkpoint = { last_completed_turn: 96, status: "in_progress", blocker_recovery: { status: "resolved",
    disposition: { guidance: "Complete the retained implementation." },
    execution_admission: { status: "awaiting_architecture_review", receipts: [{ event_id: "ORIGINAL" }] } } };
  const prompt = buildResumePrompt("Ticket", createResumeState(checkpoint));
  assert.match(prompt, /previous execution stopped after completing turn 96/);
  assert.match(prompt, /no separate Node admission step/i);
  assert.match(prompt, /actual tool approval still run/);
  assert.doesNotMatch(prompt, /NODE EXECUTION ADMISSION REVIEW/);
  assert.match(admissionPrompt(checkpoint.blocker_recovery.execution_admission), /ORIGINAL/);
  assert.match(blockerHandoffPrompt(), /SL returns actionable implementation/);
});

test("restart restores a parked admission error to one SL handoff and Coder checkpoint 96", async (t) => {
  const { f, receipts } = await fixture(t);
  await f.recreate().tick();
  const job = (await f.ledger()).jobs[0];
  assert.equal(job.status, "resume_pending", JSON.stringify({ last_error: job.last_error, feedback: job.validation_feedback }));
  assert.deepEqual(f.calls, ["sprint_leader"]);
  assert.equal(job.execution_admission.status, "retained_for_audit");
  assert.equal(job.execution_admission.decision, undefined);
  await f.recovery.tick();
  const saved = await f.base.checkpoints.load("TASK");
  assert.equal(f.base.invocations, 2);
  assert.equal(saved.last_completed_turn, 96);
  assert.equal(saved.thread_id, "PRESERVED");
  assert.deepEqual(saved.contract_decisions, receipts);
  assert.equal((await f.ledger()).jobs[0].status, "resumed");
  await f.recovery.tick(); assert.deepEqual(f.calls, ["sprint_leader"]);
});

for (const mutation of ["stop", "replaceExecution", "revokePlan"]) {
  test(`AM handoff recovery cannot revive ${mutation}`, async (t) => {
    const { f } = await fixture(t);
    if (mutation === "stop") await f.recovery.cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
    else f.base[mutation]();
    await f.recreate().tick();
    assert.equal(f.base.invocations, 1);
    assert.equal(f.calls.length, 0);
  });
}

test("a retained AM access decision is inherited by SL without inventing permission to execute a denied tool", async (t) => {
  const { f } = await fixture(t, { event_id: "ORIGINAL", tool: "edit_diff", error: { code: "APPROVAL_DENIED" } });
  await f.recreate().tick();
  const job = (await f.ledger()).jobs[0];
  assert.equal(job.status, "resume_pending", JSON.stringify(job.validation_feedback));
  assert.equal(job.execution_admission.decision, undefined);
  assert.equal(job.execution_admission.receipts[0].error.code, "APPROVAL_DENIED");
  await f.recovery.tick();
  assert.equal(f.base.invocations, 2);
  assert.deepEqual(f.calls, ["sprint_leader"]);
});

test("missing or corrupted AM evidence cannot clear an old admission stop", async (t) => {
  const { f, receipts } = await fixture(t);
  await f.base.fileService.atomicWrite({ path: receipts[0].path, content: "changed immutable evidence", replace: true });
  await f.recreate().tick();
  assert.equal(f.base.invocations, 1);
  assert.equal(f.calls.length, 0);
});

/** Reproduces the persisted v1 failure: an AM-only action was misreported as a
 * Sprint scope error, later AM/SL replies waited on validation, and live feedback
 * was cleared. Recovery must use the authenticated decision and retained turn. */
test("old wrong-action validation wait restores the settled AM answer and resumes checkpoint 96 once", async (t) => {
  const { f, job, decision } = await fixture(t);
  Object.assign(job, { handoff_policy: "am-handoff-v1", execution_admission: null, validation_feedback: null,
    resolution: { action: "reconciliation_required", reconciliation: { kind: "tooling", waiting_for: [{ owner: "external", operation: "inspect", question: "Await validator result." }] } },
    architecture_response: { execution_id: job.request.payload.execution_id, disposition: { action: "reconciliation_required", summary: "Await Sprint validation." } },
    disposition_attempts: [{ stage: "sprint_leader", status: "rejected", received_at: 1,
      response: { text: JSON.stringify({ action: "sprint_required", authority_scope: "sprint" }) },
      validation_errors: [{ path: "/authority_scope", reason: "role_not_authorized", expected: "sprint", received: "sprint" }] },
    { stage: "sprint_leader", status: "accepted", received_at: 2, response: { text: JSON.stringify({ action: "reconciliation_required" }) } }] });
  job.technical_reconciliation = { work: job.resolution.reconciliation };
  const ledger = await f.ledger(); ledger.jobs[0] = job;
  await f.base.store.save("blocker.recovery", ledger);
  await f.recreate().tick();
  const restored = (await f.ledger()).jobs[0];
  assert.equal(restored.status, "resume_pending", JSON.stringify(restored.validation_feedback));
  assert.equal(restored.handoff_policy, "am-handoff-v2");
  assert.deepEqual(restored.architecture_response.disposition, decision);
  assert.match(restored.coordination_feedback, /rejected action sprint_required belongs to AM/);
  await f.recovery.tick(); await f.recovery.tick();
  assert.deepEqual(f.calls, ["sprint_leader"]);
  assert.equal(f.base.invocations, 2);
  assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 96);
  assert.equal(await createBlockerHandoffRefresh({ inspect: () => assert.fail("v2 must not rearm again") })(restored), false);
});

/** Reads only structured actions and validation fields: narrative references to
 * a resolved decision cannot suppress the correction or create approval. */
test("handoff correction is obsolete only after a structurally accepted SL resolved disposition", () => {
  const rejected = { stage: "sprint_leader", status: "rejected", response: { text: '{"action":"sprint_required"}' },
    validation_errors: [{ reason: "role_action_mismatch" }] };
  const job = { disposition_attempts: [rejected, { stage: "sprint_leader", status: "accepted",
    response: { text: JSON.stringify({ action: "reconciliation_required", summary: 'Historical answer had "action":"resolved".' }) } }] };
  assert.equal(blockerHandoffCorrection(job).expected_action, "resolved");
  job.disposition_attempts.push({ stage: "sprint_leader", status: "accepted", response: { text: JSON.stringify({ payload: { decision: { action: "resolved" } } }) } });
  assert.equal(blockerHandoffCorrection(job), null);
});
