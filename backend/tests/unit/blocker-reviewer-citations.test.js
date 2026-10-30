/** Covers independent Reviewer citations with physical line coordinates and
 * recovery of an already submitted report after reader normalization changes.
 * Evidence remains bound to the recorded commit/environment and original hash;
 * recovery never repeats the Reviewer SDK or grants ticket acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { blockerReviewerEvidenceFixture } from "../fixtures/blocker-reviewer-evidence-fixture.js";
import { validateBlockerReviewerEvidence, refreshBlockerReviewerEvidence } from "../../src/modules/supervisor/blocker/blocker-reviewer-source.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker/blocker-validation.js";
import { captureVerificationEnvironment, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";

/** Models a provider's completed, source-cited evidence report with coordinates
 * preserved for AM's inspection rather than treated as filesystem characters. */
function report(f, evidence) {
  return { action: "review_evidence_provided", summary: "Pinned evidence inspected.", evidence,
    review_evidence: { purpose: "blocker_evidence", subject: f.subject, outcome: "completed", summary: "Pinned evidence inspected.",
      observations: ["The fixed source checksum matches."], missing_evidence: [], findings: [], finding_updates: [] } };
}

test("source and receipt citations accept line/column coordinates while retaining original checksums and references", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    const job = await f.assignedJob();
    const receipt = job.ticket_progress.verification.receipt_index[0];
    const value = report(f, [{ ...f.evidence, path: `${f.evidence.path}:1` }, { path: `${f.artifactPath}:2:3`, sha256: receipt.receipt_sha256 }]);
    await f.base.fileService.atomicWrite({ path: f.evidence.path, content: "export const changedWorkspace = true;\n", replace: true });
    assert.deepEqual(await validateBlockerReviewerEvidence(value, job, f.projectRoot), value);
    assert.equal(value.evidence[0].path, `${f.evidence.path}:1`);
    const missing = report(f, [{ ...f.evidence, path: "backend/src/absent.js:17" }]);
    await assert.rejects(validateBlockerReviewerEvidence(missing, job, f.projectRoot), (error) => {
      assert.equal(error.code, "BLOCKER_DISPOSITION_INVALID");
      assert.equal(error.validation_errors[0].path, "/evidence/0/path");
      assert.equal(error.validation_errors[0].reason, "reviewer_evidence_missing");
      assert.match(error.message, /backend\/src\/absent.js:17/);
      return true;
    });
    await assert.rejects(validateBlockerReviewerEvidence(report(f, [{ ...f.evidence, path: `${f.evidence.path}:1`, sha256: "f".repeat(64) }]), job, f.projectRoot),
      (error) => error.validation_errors[0].path === "/evidence/0/sha256");
  } finally { await f.close(); }
});

test("dependency citations resolve against recorded environment bytes and cannot fall back to a mutable workspace file", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    const path = "backend/tests/unit/recorded-rule.js", content = "export const recordedRule = 80;\n";
    await f.base.fileService.atomicWrite({ path, content, replace: false });
    const environment = await captureVerificationEnvironment({ projectRoot: f.projectRoot, ticketPaths: [f.evidence.path] });
    const binding = await persistVerificationEnvironment(f.projectRoot, environment);
    await f.base.fileService.atomicWrite({ path: f.artifactPath, content: JSON.stringify({ ...f.artifact, environment: binding }), replace: true });
    const job = await f.assignedJob();
    await f.base.fileService.atomicWrite({ path, content: "export const recordedRule = 999;\n", replace: true });
    const value = report(f, [{ path: `${path}:1:2`, sha256: createHash("sha256").update(content).digest("hex") }]);
    await validateBlockerReviewerEvidence(value, job, f.projectRoot);
    const absent = "backend/tests/unit/new-workspace-only.js";
    await f.base.fileService.atomicWrite({ path: absent, content, replace: false });
    await assert.rejects(validateBlockerReviewerEvidence(report(f, [{ ...value.evidence[0], path: `${absent}:1` }]), job, f.projectRoot),
      (error) => error.validation_errors[0].reason === "reviewer_evidence_missing");
  } finally { await f.close(); }
});

test("restart validates a retained ENOENT report and returns it to AM without another Reviewer invocation", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.recovery.tick(); await f.recovery.tick();
    const response = blockerResponseEvidence(report(f, [{ ...f.evidence, path: `${f.evidence.path}:1` }]));
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger(), job = ledger.jobs[0];
      job.status = "reconciliation_required"; job.outcome_reason = "ENOENT";
      job.validation_feedback = [{ path: "/", reason: "ENOENT", message: "File is absent from the recorded verification environment." }];
      job.disposition_attempts.push({ stage: "reviewer", assignment_id: "LEGACY-REVIEWER-INVOCATION", status: "rejected", response });
      await f.base.store.save("blocker.recovery", ledger);
    });
    await f.recreate().tick();
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.stage, "architecture_manager");
    assert.equal(job.reviewer_evidence.status, "completed");
    assert.equal(job.disposition_attempts.at(-1).status, "accepted");
    assert.deepEqual(job.disposition_attempts.at(-1).response, response);
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager"]);
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
    assert.equal(await f.base.checkpoints.loadReview("TASK"), null);
    await f.recovery.tick(); await f.recovery.tick(); await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].status, "resumed");
    assert.equal(f.calls.includes("reviewer"), false);
  } finally { await f.close(); }
});

test("report refresh preserves Stop, unknown provider outcomes, wrong subjects and missing evidence", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    const job = await f.assignedJob();
    Object.assign(job, { status: "reconciliation_required", outcome_reason: "ENOENT", disposition_attempts: [
      { stage: "reviewer", status: "rejected", response: blockerResponseEvidence(report(f, [f.evidence])) } ] });
    for (const patch of [{ status: "cancelled" }, { outcome_reason: "BLOCKER_PROVIDER_UNKNOWN" }]) {
      const blocked = { ...structuredClone(job), ...patch };
      assert.equal(await refreshBlockerReviewerEvidence(blocked, f.projectRoot, 1000), false);
      assert.deepEqual(blocked, { ...job, ...patch });
    }
    const missing = structuredClone(job);
    missing.disposition_attempts[0].response = blockerResponseEvidence(report(f, [{ ...f.evidence, path: "backend/src/absent.js:3" }]));
    assert.equal(await refreshBlockerReviewerEvidence(missing, f.projectRoot, 1000), false);
    const wrong = structuredClone(job), value = report(f, [f.evidence]);
    value.review_evidence.subject = { ...f.subject, commit_sha: "f".repeat(40) };
    wrong.disposition_attempts[0].response = blockerResponseEvidence(value);
    assert.equal(await refreshBlockerReviewerEvidence(wrong, f.projectRoot, 1000), false);
  } finally { await f.close(); }
});
