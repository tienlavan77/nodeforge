/** Exercises the full AM -> independent Reviewer -> AM -> SL -> Coder route,
 * preserving checkpoint identity, Stop fencing, immutable receipts and formal
 * review state while keeping evidence collection distinct from acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerReviewerEvidenceFixture } from "../fixtures/blocker-reviewer-evidence-fixture.js";
import { validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { validateBlockerReviewerEvidence } from "../../src/modules/supervisor/blocker-reviewer-source.js";
import { validateReviewerEvidenceResult } from "../../src/modules/supervisor/blocker-reviewer-evidence.js";
import { assignAuthorityConsultation } from "../../src/modules/supervisor/blocker-authority-consultation.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";

test("AM obtains independent evidence, decides, returns to SL and resumes Coder without formal review or checkpoint reset", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.recovery.tick(); await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].stage, "reviewer");
    await f.recreate().tick();
    const returned = (await f.ledger()).jobs[0];
    assert.equal(returned.stage, "architecture_manager");
    assert.equal(returned.reviewer_evidence.status, "completed");
    assert.equal(returned.architecture_response, undefined);
    assert.equal(f.base.invocations, 1);
    const retained = await f.base.checkpoints.load("TASK");
    assert.equal(retained.last_completed_turn, before.last_completed_turn);
    assert.equal(retained.stage_progress.some((entry) => entry.stage === "reviewer"), false);
    assert.equal(retained.stage_progress.findLast((entry) => entry.stage === "reviewer_evidence").status, "completed");
    assert.equal(await f.base.checkpoints.loadReview("TASK"), null);
    await f.recreate().tick();
    assert.equal((await f.ledger()).jobs[0].stage, "sprint_leader");
    await f.recovery.tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "reviewer", "architecture_manager", "sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.ledger()).jobs[0].status, "resumed");
  } finally { await f.close(); }
});

test("Stop prevents a reserved independent Reviewer dispatch and explicit Resume retains its assignment", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick(); await f.recovery.tick();
    const id = (await f.ledger()).jobs[0].reviewer_evidence.id;
    await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    await f.recovery.tick();
    assert.equal(f.calls.includes("reviewer"), false);
    await f.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal((await f.ledger()).jobs[0].reviewer_evidence.id, id);
    assert.equal((await f.ledger()).jobs[0].stage, "reviewer");
    await f.recovery.tick();
    assert.equal(f.calls.filter((stage) => stage === "reviewer").length, 1);
  } finally { await f.close(); }
});

test("restart recovers AM parked on invalid JSON and obsolete capabilities before dispatching independent Reviewer", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger(), job = ledger.jobs[0];
      const original = f.request();
      original.reconciliation.waiting_for = ["Independent report for the retained artifact."];
      assignAuthorityConsultation(job, original, 1000);
      job.authority_consultations.at(-1).coordination_evidence.independent_reviewer_preparation = "not_supported";
      job.status = "reconciliation_required";
      job.outcome_reason = "disposition_correction_no_progress";
      job.validation_feedback = [{ path: "/", reason: "json_invalid", message: "Unclosed outer object." }];
      job.disposition_attempts = [{ stage: "architecture_manager", status: "rejected", response: blockerResponseEvidence('{"kind":') }];
      await f.base.store.save("blocker.recovery", ledger);
    });
    await f.recreate().tick();
    const resumed = (await f.ledger()).jobs[0];
    assert.equal(resumed.stage, "reviewer");
    assert.deepEqual(f.calls, ["architecture_manager"]);
    assert.equal(resumed.disposition_attempts[0].response.text, '{"kind":');
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, before.last_completed_turn);
    await f.recreate().tick(); await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["architecture_manager", "reviewer", "architecture_manager", "sprint_leader"]);
    assert.equal((await f.ledger()).jobs[0].status, "resumed");
    assert.equal(f.base.invocations, 2);
  } finally { await f.close(); }
});

test("Reviewer subjects require a fixed commit, artifact and read-only operation", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    for (const patch of [{ subject: undefined }, { operation: "execute" }, { subject: { commit_sha: "HEAD", artifact_id: "ARTIFACT-X" } }]) {
      const value = f.request();
      Object.assign(value.reconciliation.waiting_for[0], patch);
      assert.throws(() => validateTechnicalReconciliation(value, { stage: "architecture_manager" }), { code: "BLOCKER_DISPOSITION_INVALID" });
    }
    const job = await f.assignedJob();
    job.stage = "architecture_manager";
    const value = f.request();
    value.reconciliation.waiting_for[0].subject = { ...f.subject, commit_sha: "f".repeat(40) };
    await assert.rejects(validateBlockerDisposition(value, { job, projectRoot: f.projectRoot, fileService: f.base.fileService }), /issued artifact/);
  } finally { await f.close(); }
});

test("evidence-only reports cannot approve acceptance, change findings or substitute another source identity", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    const job = await f.assignedJob();
    const value = { action: "review_evidence_provided", summary: "Observed.", evidence: [f.evidence], review_evidence: {
      purpose: "blocker_evidence", subject: f.subject, outcome: "completed", summary: "Observed.", observations: ["Source inspected."], missing_evidence: [], findings: [], finding_updates: [] } };
    for (const patch of [{ verdict: "approved" }, { findings: [{ id: "REV-1" }] }, { finding_updates: [{ status: "closed" }] },
      { subject: { ...f.subject, commit_sha: "f".repeat(40) } }, { outcome: "inconclusive" }]) {
      assert.throws(() => validateReviewerEvidenceResult({ ...value, review_evidence: { ...value.review_evidence, ...patch } }, job));
    }
    await assert.rejects(validateBlockerReviewerEvidence({ ...value, evidence: [{ ...f.evidence, sha256: "f".repeat(64) }] }, job, f.projectRoot), /exact source/);
    await f.base.fileService.atomicWrite({ path: f.artifactPath, content: JSON.stringify({ ...f.artifact, project_id: "OTHER" }), replace: true });
    await assert.rejects(validateBlockerReviewerEvidence(value, job, f.projectRoot), /artifact changed/);
  } finally { await f.close(); }
});
