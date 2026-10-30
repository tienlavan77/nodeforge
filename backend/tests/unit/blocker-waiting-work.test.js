// Verifies missing evidence is assigned durably through SL while real external boundaries remain blocked.
import assert from "node:assert/strict";
import test from "node:test";
import { assignWaitingWork, completeWaitingWork, validWaitingInput } from "../../src/modules/supervisor/blocker/blocker-waiting-work.js";
import { scheduleTechnicalReconciliation, validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker/blocker-technical-reconciliation.js";
import { restoreSprintRecovery } from "../../src/modules/supervisor/blocker/blocker-sprint-handoff.js";
import { returnArchitectureResponse } from "../../src/modules/supervisor/blocker/blocker-architecture-response.js";
import { transitionCoderCandidate } from "../../src/modules/supervisor/blocker/blocker-coder-candidate.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { completeAuthorityConsultation } from "../../src/modules/supervisor/blocker/blocker-authority-consultation.js";

// Supplies identity-bound source evidence without asserting the source journal conflict has been resolved.
function jobFixture() {
  return { id: "J", stage: "sprint_leader", status: "pending", history: [], reason_code: "CONTRACT_DECISION_REQUIRED",
    request: { task_id: "T", project_id: "P", payload: { execution_id: "E" }, execution_context: { base_sha: "base" },
      ticket: { acceptance_criteria: ["Keep the existing contract."], file_budget: 4 } } };
}

const wait = { action: "reconciliation_required", summary: "Source drift needs explanation and an actual permission boundary remains.",
  guidance: "Preserve current source and explain the foreign delta to SL.", evidence: [{ path: "router.js", sha256: "a".repeat(64) }],
  reconciliation: { kind: "source_revision", prerequisite: "Source/provenance comparison and denied-operation disposition.",
    completed_checks: ["The live router differs from the ticket-owned journal."], next_check: "Read the baseline diff and explain the current delta.",
    waiting_for: [{ owner: "coder", operation: "inspect", question: "Compare the current source and retained journal; distinguish unknown authorship from observed changes." },
      { owner: "external", question: "A real permission decision is required if no permitted alternative exists." }] } };

/** Starts evidence-owner tests after AM has reviewed this exact reconciliation;
 * the scheduler must then let SL coordinate the already-decided evidence work. */
function scheduleAfterArchitecture(job, value, now) {
  const stage = job.stage;
  job.stage = "architecture_manager";
  completeAuthorityConsultation(job, value, now);
  job.stage = stage;
  scheduleTechnicalReconciliation(job, value, now);
}

test("mixed waits require AM decision before read-only Coder work and retain the external denial boundary", () => {
  const job = jobFixture();
  validateTechnicalReconciliation(wait, job);
  scheduleTechnicalReconciliation(job, wait, 1);
  assert.equal(job.stage, "architecture_manager");
  assert.equal(job.coder_exchange, undefined);
  returnArchitectureResponse(job, wait, 2);
  scheduleTechnicalReconciliation(job, wait, 3);
  assert.equal(job.stage, "coder");
  assert.equal(job.status, "pending");
  assert.equal(job.waiting_assignments[1].owner, "external");
  assert.equal(job.coder_exchange.request.questions.length, 1);
  assert.match(job.coder_exchange.request.constraints.join(" "), /do not edit, test, commit/);
  assert.equal(job.waiting_work_history[0].status, "assigned");
  assert.equal(job.request.payload.execution_id, "E");
});

test("Coder findings return to SL and identical or reworded work cannot repeat across restart", () => {
  const job = jobFixture();
  scheduleAfterArchitecture(job, wait, 1);
  const response = { action: "architecture_required", summary: "The extra authentication argument is outside the journal.",
    guidance: "No journal provenance can be inferred; the source conflict remains. Preserve all changes." };
  completeWaitingWork(job, response, 2);
  transitionCoderCandidate(job, response, 2);
  const restarted = structuredClone(job);
  scheduleTechnicalReconciliation(restarted, { ...wait, reconciliation: { ...wait.reconciliation,
    waiting_for: [{ owner: "coder", question: "Reworded request to inspect the same source again." }] } }, 3);
  assert.equal(restarted.stage, "sprint_leader");
  assert.equal(restarted.status, "notification_pending");
  assert.equal(restarted.waiting_work_history.length, 1);
  assert.equal(restarted.waiting_work_history[0].response.summary, response.summary);
  assert.match(restarted.coordination_feedback, /already ran/);
});

test("future verification and unspecified Coder work behind external prerequisites never launch read-only preparation", () => {
  for (const operation of ["execute", undefined]) {
    const job = jobFixture();
    scheduleAfterArchitecture(job, { ...wait, reconciliation: { ...wait.reconciliation,
      waiting_for: [{ owner: "external", question: "Resolve actual source provenance and the denied mutation first." },
        { owner: "coder", ...(operation ? { operation } : {}), question: "After prerequisites clear, supply real-HTTP verification results." }] } }, 1);
    assert.equal(job.status, "notification_pending");
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.coder_exchange, undefined);
  }
});

test("read-only inspection can run alongside deferred verification without receiving executable work", () => {
  const job = jobFixture();
  assignWaitingWork(job, { ...wait, reconciliation: { ...wait.reconciliation, waiting_for: [
    { owner: "external", question: "Resolve actual permission." },
    { owner: "coder", operation: "inspect", question: "Compare current source only." },
    { owner: "coder", operation: "execute", question: "Run real HTTP integration tests after permission is resolved." }
  ] } }, 1);
  assert.equal(job.stage, "coder");
  assert.deepEqual(job.coder_exchange.request.questions, ["Compare current source only."]);
  assert.equal(job.waiting_assignments[2].operation, "execute");
});

test("changed conversation progress and additional supporting files cannot requeue the same contract-source investigation", () => {
  const job = jobFixture();
  job.request.ticket.execution_policy = { contract_evidence: [{ path: "router.js", sha256: "baseline" }] };
  job.ticket_progress = { pending_criterion_ids: ["AC-1"], evidence_sha256: "before-SL-and-Coder-response" };
  assignWaitingWork(job, wait, 1);
  const response = { action: "architecture_required", summary: "Source compared; no provenance supplied.", guidance: "External evidence remains unavailable." };
  completeWaitingWork(job, response, 2);
  transitionCoderCandidate(job, response, 2);
  const restarted = structuredClone(job);
  restarted.ticket_progress.evidence_sha256 = "after-new-SL-wording-and-file-list";
  // Emulates a persisted assignment created by the previous fingerprint algorithm.
  restarted.waiting_work_history[0].fingerprint = "legacy-key-that-included-conversation-progress";
  scheduleAfterArchitecture(restarted, { ...wait, evidence: [...wait.evidence, { path: "review-routes.js", sha256: "b".repeat(64) }] }, 3);
  assert.equal(restarted.status, "notification_pending");
  assert.equal(restarted.stage, "sprint_leader");
  assert.equal(restarted.waiting_work_history.length, 1);
});

test("new source evidence can be investigated without changing approval or ticket scope", () => {
  const job = jobFixture();
  job.ticket_progress = { pending_criterion_ids: ["AC-1"], evidence_sha256: "unchanged-summary-of-blocked-provenance" };
  assignWaitingWork(job, wait, 1);
  const response = { action: "architecture_required", summary: "Unknown writer.", guidance: "Preserve changes." };
  completeWaitingWork(job, response, 2);
  transitionCoderCandidate(job, response, 2);
  assert.equal(assignWaitingWork(job, { ...wait, evidence: [{ path: "router.js", sha256: "b".repeat(64) }] }, 3), true);
  assert.equal(job.stage, "coder");
  assert.equal(job.waiting_work_history.length, 2);
  assert.equal(job.execution_admission, undefined);
});

test("new Node journal facts permit one comparison but wording and unrelated files cannot replay it", () => {
  const job = jobFixture();
  const response = { action: "architecture_required", summary: "Missing Node journal.", guidance: "Supply retained evidence." };
  assignWaitingWork(job, wait, 1);
  completeWaitingWork(job, response, 2);
  transitionCoderCandidate(job, response, 2);
  job.ticket_progress = { pending_criterion_ids: ["AC-1"], source_reconciliation: {
    status: "observed", parent_sha: "HEAD", files: [{ path: "router.js", operations: [{ id: "OP" }] }] } };
  assert.equal(assignWaitingWork(job, wait, 3), true);
  completeWaitingWork(job, response, 4);
  transitionCoderCandidate(job, response, 4);
  job.ticket_progress.source_reconciliation.files.push({ path: "unrelated.js", operations: [{ id: "OTHER" }] });
  assert.equal(assignWaitingWork(job, { ...wait, summary: "Reworded" }, 5), false);
  assert.equal(job.waiting_work_history.length, 2);
});

test("external input remains parked and AM evidence requests return to SL before Coder", () => {
  const external = jobFixture();
  scheduleAfterArchitecture(external, { ...wait, reconciliation: { ...wait.reconciliation,
    waiting_for: [{ owner: "external", question: "The actual mutation remains denied." }] } }, 1);
  assert.equal(external.status, "notification_pending");
  assert.equal(external.coder_exchange, undefined);
  const am = { ...jobFixture(), stage: "architecture_manager" };
  returnArchitectureResponse(am, wait, 1);
  assert.equal(am.stage, "sprint_leader");
  assert.equal(am.status, "pending");
  assert.equal(am.coder_exchange, undefined);
  assert.equal(am.history[0].event, "architecture_answer_returned");
  scheduleTechnicalReconciliation(am, wait, 2);
  assert.equal(am.stage, "coder");
  assert.equal(am.coder_exchange.review_role, "sprint_leader");
});

test("explicit Architecture questions and legacy source waits resume into AM before Coder preparation", () => {
  const job = jobFixture();
  scheduleTechnicalReconciliation(job, { ...wait, reconciliation: { ...wait.reconciliation,
    waiting_for: [{ owner: "architecture_manager", question: "Does the existing design permit the observed compatibility boundary?" }] } }, 1);
  assert.equal(job.stage, "architecture_manager");
  const legacy = { ...jobFixture(), status: "reconciliation_required", resolution: { ...wait,
    reconciliation: { ...wait.reconciliation, waiting_for: ["Explain current router provenance and the remaining contract conflict."] } } };
  restoreSprintRecovery(legacy, 2);
  assert.equal(legacy.stage, "architecture_manager");
  assert.equal(legacy.coder_exchange, undefined);
  assert.equal(legacy.authority_consultations[0].status, "assigned");
  restoreSprintRecovery(legacy, 3);
  assert.equal(legacy.stage, "architecture_manager", "Resume must retain the pending AM decision");
});

test("invalid ownership input is rejected and a retained candidate requires an explicit SL review", () => {
  for (const input of [{ owner: "owner", question: "Approve me" }, { owner: "coder", question: "" },
    { owner: "coder", question: "Question", allow_write: true }, null]) assert.equal(validWaitingInput(input), false);
  assert.throws(() => validateTechnicalReconciliation({ ...wait, reconciliation: { ...wait.reconciliation,
    waiting_for: [{ owner: "unknown", question: "Question" }] } }, jobFixture()), { code: "BLOCKER_DISPOSITION_INVALID" });
  const job = { ...jobFixture(), coder_exchange: { candidate: { sha256: "existing-candidate" } } };
  assert.equal(assignWaitingWork(job, wait, 1), false);
  assert.equal(job.coder_exchange.candidate.sha256, "existing-candidate");
});

test("production SL → AM → SL → Coder evidence → SL survives restart and preserves the blocked execution", async () => {
  const f = await blockerRecoveryFixture({ investigate: async (job, resolution) => job.stage === "coder"
    ? { action: "architecture_required", summary: "The source comparison is complete; authorship and permission cannot be inferred.", guidance: "Preserve the checkpoint and report the actual external provenance/permission prerequisite." }
    : job.waiting_work_history?.some((entry) => entry.status === "answered")
      ? { ...wait, evidence: resolution.evidence, reconciliation: { ...wait.reconciliation,
        waiting_for: [{ owner: "external", question: "Supply verifiable provenance for the foreign write; no source journal update was performed." }] } }
      : { ...wait, evidence: resolution.evidence } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].stage, "architecture_manager");
    await f.recovery.tick(); await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].stage, "coder");
    f.recreate();
    await f.recovery.tick();
    await f.recovery.tick();
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "coder", "sprint_leader"]);
    assert.equal(f.base.invocations, 1);
    assert.equal(f.base.integrations, 0);
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.status, "reconciliation_required");
    assert.equal(job.waiting_work_history[0].status, "answered");
    const after = await f.base.checkpoints.load("TASK");
    assert.equal(after.last_completed_turn, before.last_completed_turn);
    assert.equal(f.base.statusStore.get().details.execution_id, "EXEC");
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "coder", "sprint_leader"]);
  } finally { await f.close(); }
});

test("Stop fences an assigned evidence investigation before Coder can be called", async () => {
  const f = await blockerRecoveryFixture({ investigate: async (_job, resolution) => ({ ...wait, evidence: resolution.evidence }) });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].stage, "architecture_manager");
    await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    f.recreate();
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal(f.base.invocations, 1);
    assert.equal((await f.ledger()).cancelled, true);
  } finally { await f.close(); }
});
