// Reproduces stale retained AM citations without confusing them with current SL evidence, including restart and legacy recovery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker/blocker-recovery-contract.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker/blocker-validation.js";
import { discoveryAssignment } from "../../src/modules/supervisor/blocker/blocker-discovery-checkpoint.js";

const quote = "Keep project-local data and the existing public contract; implement compatible internal adapters.";
const basis = { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) };
const assessment = { rationale: "The approved structure and public contract remain unchanged.", changes_structure: false,
  changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false };

// Provides separate files for AM's supporting evidence and SL's handoff so a validator cannot accidentally attribute one to the other.
async function setup({ changedGuidance } = {}) {
  let amCalls = 0;
  let references;
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job, resolution) => {
    if (job.stage === "architecture_manager") {
      amCalls += 1;
      if (amCalls > 1) {
        assert.equal(job.delegation_evidence_review.status, "assigned");
        assert.equal(job.delegation_evidence_review.changes.length, 2);
        for (const ref of references) assert.ok(job.consultation_request.question.includes(ref.path));
        assert.match(job.consultation_request.question, /Do not repeat unrelated discovery/);
      }
      return { ...resolution, authority_scope: "architecture", authority_quote: quote, architecture_basis: basis,
        boundary_assessment: assessment, evidence: references, ...(amCalls > 1 && changedGuidance ? { guidance: changedGuidance } : {}) };
    }
    return job.architecture_response ? resolution : { action: "architecture_required", summary: "Resolve the missing compatibility contract." };
  }, recoveryOptions: { architecturePlans: { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "architecture.md", markdown: quote }) } } });
  const ready = fixture.base.registry.assertReady;
  fixture.base.registry.assertReady = async (...args) => {
    const value = await ready(...args);
    return { ...value, plan: { ...value.plan, proposal_id: `${basis.plan_id}-R1-${basis.sha256}`, source_path: "architecture.md", source_sha256: basis.sha256 } };
  };
  // Writes a new observed revision without changing the approved Architecture identity or the ticket's own implementation evidence.
  async function writeSources(revision) {
    references = [];
    for (const path of ["backend/src/router.js", "backend/src/runtime.js"]) {
      const content = `export const revision = ${revision};\n`;
      await fixture.base.fileService.atomicWrite({ path, content, replace: true });
      references.push({ path, sha256: createHash("sha256").update(content).digest("hex") });
    }
  }
  await writeSources(1);
  await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
  await fixture.recovery.tick();
  await fixture.recovery.tick();
  return { fixture, writeSources };
}

test("changed AM citations produce one scoped review, then reuse the saved SL handoff across restart", async () => {
  const { fixture, writeSources } = await setup();
  try {
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    const original = structuredClone((await fixture.ledger()).jobs[0].sprint_delegation);
    await writeSources(2);
    const job = (await fixture.ledger()).jobs[0];
    await assert.rejects(validateBlockerDisposition(fixture.resolution, { job, plan: {}, architecture: { basis, markdown: quote },
      fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot }), (error) => {
      assert.equal(error.delegation_evidence_changed, true);
      assert.equal(error.validation_errors.length, 2);
      for (const [index, failure] of error.validation_errors.entries()) {
        assert.equal(failure.path, `/sprint_delegation/evidence/${index}/sha256`);
        assert.equal(failure.decision_owner, "architecture_manager");
        assert.equal(failure.received, original.evidence[index].sha256);
        assert.notEqual(failure.received, failure.expected);
      }
      return true;
    });
    await fixture.recovery.tick();
    let current = (await fixture.ledger()).jobs[0];
    assert.equal(current.stage, "architecture_manager");
    assert.equal(current.status, "pending");
    assert.deepEqual(current.sprint_delegation, original);
    assert.equal(current.disposition_attempts.at(-1).stage, "sprint_leader");
    assert.equal(fixture.base.integrations, 0);
    await fixture.recreate().tick();
    current = (await fixture.ledger()).jobs[0];
    assert.equal(current.stage, "sprint_leader");
    assert.equal(current.delegation_evidence_review.status, "answered");
    await fixture.recovery.tick();
    current = (await fixture.ledger()).jobs[0];
    assert.equal(current.status, "resume_pending");
    assert.equal(current.delegation_evidence_review.status, "consumed");
    assert.equal(current.disposition_attempts.at(-1).stage, "sprint_leader");
    assert.equal(current.disposition_attempts.at(-1).status, "accepted");
    assert.equal(current.disposition_attempts.at(-3).stage, "sprint_leader");
    assert.equal(current.disposition_attempts.at(-3).status, "rejected");
    assert.equal((await fixture.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
    await fixture.recovery.tick();
    assert.equal(fixture.base.integrations, 1);
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "architecture_manager"]);
  } finally { await fixture.close(); }
});

test("legacy unqualified evidence errors are rechecked and routed to AM without repeating SL", async () => {
  const { fixture, writeSources } = await setup();
  try {
    await writeSources(2);
    await fixture.base.store.withLock("blocker.recovery", async () => {
      const ledger = await fixture.ledger(), job = ledger.jobs[0];
      job.status = "reconciliation_required";
      job.outcome_reason = "disposition_correction_no_progress";
      job.validation_feedback = [{ path: "/evidence/0/sha256", reason: "evidence_stale", message: "Blocker evidence is stale." }];
      job.disposition_attempts.push({ stage: "sprint_leader", assignment_id: discoveryAssignment(job), status: "rejected",
        response: blockerResponseEvidence(fixture.resolution), validation_errors: job.validation_feedback });
      ledger.deadline_at = 0;
      await fixture.base.store.save("blocker.recovery", ledger);
    });
    await fixture.recreate().tick();
    assert.equal((await fixture.ledger()).jobs[0].delegation_evidence_review.status, "answered");
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.integrations, 1);
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "architecture_manager"]);
  } finally { await fixture.close(); }
});

test("SL's own stale evidence stays an SL correction and does not trigger another AM decision", async () => {
  const { fixture } = await setup();
  try {
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "changed SL source\n", replace: true });
    await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.status, "pending");
    assert.equal(job.validation_feedback[0].path, "/evidence/0/sha256");
    assert.equal(job.delegation_evidence_review, undefined);
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("Stop prevents the focused AM review from dispatching", async () => {
  const { fixture, writeSources } = await setup();
  try {
    await writeSources(2);
    await fixture.recovery.tick();
    await fixture.recovery.cancel({ projectId: "P", taskId: "TASK", executionId: "EXEC" });
    await fixture.recreate().tick();
    assert.equal(fixture.calls.filter((role) => role === "architecture_manager").length, 1);
    assert.equal((await fixture.ledger()).jobs[0].status, "cancelled");
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("an unresolved AM answer cannot reuse SL's previously proposed resume", async () => {
  const { fixture, writeSources } = await setup();
  try {
    await writeSources(2);
    await fixture.recovery.tick();
    await fixture.recreate({ investigate: async () => ({ action: "reconciliation_required", summary: "The current router needs a concrete compatibility check.",
      guidance: "Inspect the changed adapter before deciding whether the retained contract still applies.",
      reconciliation: { kind: "source_revision", prerequisite: "Adapter behavior is not yet reconciled.",
        completed_checks: ["Confirmed that the supporting source changed."], next_check: "Compare the changed adapter against the approved routing contract." } }) }).tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.delegation_evidence_review.status, "unresolved");
    assert.notEqual(job.status, "resume_pending");
    assert.equal(job.sprint_delegation, undefined);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("unknown provider outcomes retain their fence even when legacy evidence feedback is stale", async () => {
  const { fixture, writeSources } = await setup();
  try {
    await writeSources(2);
    await fixture.base.store.withLock("blocker.recovery", async () => {
      const ledger = await fixture.ledger(), job = ledger.jobs[0];
      job.status = "reconciliation_required";
      job.outcome_reason = "BLOCKER_PROVIDER_UNKNOWN";
      job.validation_feedback = [{ path: "/evidence/0/sha256", reason: "evidence_stale", message: "Historical feedback." }];
      await fixture.base.store.save("blocker.recovery", ledger);
    });
    await fixture.recreate().tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.outcome_reason, "BLOCKER_PROVIDER_UNKNOWN");
    assert.equal(job.delegation_evidence_review, undefined);
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("changed AM implementation guidance requires a fresh SL decision instead of replaying its old proposal", async () => {
  const { fixture, writeSources } = await setup({ changedGuidance: "Use the revised adapter before resuming the existing checkpoint." });
  try {
    await writeSources(2);
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].delegation_evidence_review.handoff_reusable, false);
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
  } finally { await fixture.close(); }
});
