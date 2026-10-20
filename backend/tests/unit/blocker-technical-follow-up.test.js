// Exercises technical follow-up through durable ticket recovery without owner resets or bypassing admission.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";
import { technicalReconciliationPrompt } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";

const technical = { action: "reconciliation_required", summary: "The approved contract needs a baseline comparison.",
  guidance: "Compare the retained execution baseline and current source, then complete the existing design.",
  reconciliation: { kind: "source_revision", prerequisite: "The source revision comparison is incomplete.",
    completed_checks: ["The partial handler exists but its baseline has not yet been inspected."], next_check: "Inspect baseline and current handler source." } };
const result = { findings: ["The current handler preserves the approved request shape; the missing project service binding is implementation work."],
  implementation_steps: ["Bind the approved handler to the selected project services."], verification_steps: ["Run focused routing tests against two distinct roots."],
  admission: { status: "within_existing_permissions", rationale: "The proposed handler change uses existing permissions and does not repeat a denied operation." } };

// Advances only bounded recovery polls so tests cannot mask a runaway investigation.
async function ticks(fixture, count) { for (let i = 0; i < count; i += 1) await fixture.recovery.tick(); }

test("Node assigns implementation comparison to SL and resumes Coder after a validated handoff", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "sprint_leader" && !job.technical_reconciliation) return { action: "architecture_required", summary: "Complete technical contract research." };
    if (!job.technical_reconciliation) return { ...technical, evidence: resolution.evidence };
    assert.equal(job.technical_reconciliation.assigned_role, "sprint_leader");
    assert.equal(job.technical_reconciliation.round, 1);
    assert.equal(job.request.payload.execution_id, "EXEC");
    assert.equal(job.authority_context.file_claims.some((claim) => claim.owner_task_id), false);
    return { ...resolution, technical_result: result };
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await ticks(fixture, 2);
    const before = await fixture.ledger();
    assert.equal(before.jobs[0].status, "pending");
    assert.equal(fixture.base.invocations, 1);
    const deadline = before.deadline_at;
    await fixture.recreate().tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    await fixture.recovery.tick();
    const after = await fixture.ledger();
    assert.equal(after.jobs.length, 1);
    assert.equal(after.deadline_at, deadline);
    assert.equal(after.jobs[0].status, "resumed");
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    assert.deepEqual(checkpoint.blocker_recovery.disposition.technical_result, result);
  } finally { await fixture.close(); }
});

test("changing summary wording cannot bypass repeated-finding detection across restart", async () => {
  let turns = 0;
  const fixture = await blockerRecoveryFixture({ investigate: async () => ({ ...technical, summary: `Incomplete attempt ${++turns}` }) });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await ticks(fixture, 2);
    fixture.recreate();
    await ticks(fixture, 8);
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "reconciliation_required");
    assert.equal(job.outcome_reason, "technical_reconciliation_no_progress");
    assert.equal(job.technical_reconciliation.round, 1);
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.events.some((event) => event.type === "task.blocker.owner_decision_required"), false);
    assert(job.history.some((entry) => entry.remaining_prerequisite === technical.reconciliation.prerequisite));
  } finally { await fixture.close(); }
});

test("new source evidence continues beyond three rounds within the original deadline", async () => {
  let turn = 0;
  let fixture;
  fixture = await blockerRecoveryFixture({ investigate: async () => ({ ...technical,
    evidence: [fixture.evidence, { path: `backend/dependency-${++turn}.js`, sha256: fixture.evidence.sha256 }],
    reconciliation: { ...technical.reconciliation, completed_checks: [`Inspected dependency ${turn}; execution remains blocked.`] } }) });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let index = 1; index <= 12; index += 1) await fixture.base.fileService.atomicWrite({ path: `backend/dependency-${index}.js`, content: "export const approvedHandler = true;\n", replace: true });
    await ticks(fixture, 12);
    const ledger = await fixture.ledger();
    assert.equal(ledger.jobs[0].outcome_reason, undefined);
    assert.equal(ledger.jobs[0].status, "pending");
    assert.equal(ledger.jobs[0].technical_reconciliation.round, 12);
    assert.equal(ledger.jobs[0].technical_reconciliation.max_rounds, null);
    assert.equal(fixture.calls.length, 12);
    fixture.advance(600_001);
    await ticks(fixture, 2);
    assert.equal((await fixture.ledger()).jobs[0].outcome_reason, "triage_deadline_exhausted");
    assert.equal(fixture.calls.length, 12);
    assert.equal(fixture.base.invocations, 1);
  } finally { await fixture.close(); }
});

test("Stop, source drift, and deadline expiry fence a queued technical follow-up", async () => {
  for (const boundary of ["stop", "source", "deadline"]) {
    const fixture = await blockerRecoveryFixture({ investigate: async () => technical });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await ticks(fixture, 2);
      if (boundary === "stop") await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      if (boundary === "source") {
        fixture.base.staleSource();
      }
      if (boundary === "deadline") fixture.advance(600_001);
      await ticks(fixture, 3);
      assert.equal(fixture.calls.length, 2);
      assert.equal(fixture.base.invocations, 1);
      assert.notEqual((await fixture.ledger()).jobs[0].status, "resumed");
    } finally { await fixture.close(); }
  }
});

test("resolved technical handoffs require findings, implementation, verification, admission and valid source evidence", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { stage: "architecture_manager", technical_reconciliation: { round: 1 }, request: { ticket: fixture.ticket } };
    const options = { job, plan: {}, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot };
    await assert.rejects(validateBlockerDisposition(fixture.resolution, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    for (const status of ["denied", "unresolved"]) {
      await assert.rejects(validateBlockerDisposition({ ...fixture.resolution, technical_result: { ...result, admission: { ...result.admission, status } } }, options),
        (error) => error.validation_errors[0].reason === "admission_unresolved");
    }
    await assert.rejects(validateBlockerDisposition({ ...fixture.resolution, technical_result: result,
      evidence: [{ ...fixture.evidence, sha256: "0".repeat(64) }] }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    const accepted = await validateBlockerDisposition({ ...fixture.resolution, technical_result: result }, options);
    assert.equal(accepted.action, "resolved");
    await assert.rejects(validateBlockerDisposition({ ...technical, reconciliation: { kind: "anything" } }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await fixture.close(); }
});

test("technical prompt retains denial boundaries and assigns research inside the original ticket", () => {
  const prompt = technicalReconciliationPrompt({ technical_reconciliation: { round: 1, work: technical.reconciliation } });
  assert.match(prompt, /ASSIGNED TECHNICAL WORK/);
  assert.match(prompt, /do not request a separate ticket/i);
  assert.match(prompt, /AM cannot override automatic approval review/);
  assert.match(prompt, /Node-selected baseline/);
  assert.match(prompt, /without a round-count limit/);
  assert.doesNotMatch(prompt, /stop after three/);
});

// Ensures all providers receive the completed design, comparison findings and verification steps on resume.
test("Coder resume receives the complete technical result without granting approval overrides", () => {
  const prompt = buildResumePrompt("Ticket scope", createResumeState({ status: "in_progress", last_completed_turn: 0,
    blocker_recovery: { status: "resolved", disposition: { guidance: "Continue approved work.", technical_result: result, evidence: [{ path: "backend/handler.js", sha256: "a".repeat(64) }] } } }));
  assert.match(prompt, /Validated technical handoff/);
  assert(prompt.includes(result.implementation_steps[0]));
  assert(prompt.includes(result.verification_steps[0]));
  assert.match(prompt, /does not authorize a denied operation/);
});
