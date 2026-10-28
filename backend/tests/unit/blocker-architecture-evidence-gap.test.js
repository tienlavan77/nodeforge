/** Verifies that missing historical failure diagnostics cannot discard an
 * authenticated Architecture answer or trigger another repository survey.
 * Decisions still require approved authority, current source and normal tool
 * permissions before SL can resume the retained Coder checkpoint. */
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { createBlockerFailureClassification, requiresEvidenceReconciliation } from "../../src/modules/supervisor/blocker-failure-classification.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";

const quote = "Use an internal adapter within the approved structure and preserve all runtime tool permissions.";
const basis = { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) };
const assessment = { rationale: "The guidance substitute changes no approved boundary.", changes_structure: false,
  changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false };
const technicalResult = { findings: ["The repository guidance supplies the required bounded implementation prerequisite."],
  implementation_steps: ["Continue the retained implementation using the available guidance and normal tool controls."],
  verification_steps: ["Run the ticket's focused handler checks."],
  admission: { status: "within_existing_permissions", rationale: "No denied read or new permission is needed." } };
const missing = { status: "missing", receipts: [] };

/** Supplies authenticated Architecture and current file evidence for a generic
 * blocked ticket, keeping the missing diagnostics distinct from its authority. */
async function fixtureFor(evidence = missing) {
  const readFailureEvidence = async () => evidence;
  const fixture = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: {
    readFailureEvidence, architecturePlans: { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "approved-architecture.md", markdown: quote }) }
  }, investigate: async (job, resolution) => job.stage === "architecture_manager" ? architectureAnswer(resolution)
    : job.architecture_response ? { ...resolution, authority_scope: "sprint", technical_result: technicalResult }
      : { action: "architecture_required", summary: "Decide an accessible substitute for the blocked guidance." } });
  const assertReady = fixture.base.registry.assertReady;
  fixture.base.registry.assertReady = async (...input) => {
    const ready = await assertReady(...input);
    return { ...ready, plan: { ...ready.plan, proposal_id: `${basis.plan_id}-R1-${basis.sha256}`,
      source_path: "approved-architecture.md", source_sha256: basis.sha256 } };
  };
  return Object.assign(fixture, { readFailureEvidence });
}

/** Builds AM's complete answer without self-certifying tool permission or
 * claiming that implementation and independent verification have finished. */
function architectureAnswer(resolution) {
  return { ...resolution, authority_scope: "architecture", authority_quote: quote, architecture_basis: basis,
    boundary_assessment: assessment, technical_result: technicalResult };
}

test("missing, partial and path-scope receipts preserve AM's answer and return SL to the retained Coder", async () => {
  for (const evidence of [missing, { status: "partial", receipts: [] }, { status: "captured", receipts: [
    { event_id: "READ", tool: "read_lines", error: { code: "PATH_FORBIDDEN", message: "Path outside tool scope" } }
  ] }]) {
    const f = await fixtureFor(evidence);
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      const checkpoint = await f.base.checkpoints.load("TASK");
      await f.recovery.tick();
      await f.recovery.tick();
      let job = (await f.ledger()).jobs[0];
      assert.equal(job.stage, "sprint_leader");
      assert.equal(job.status, "pending");
      assert.equal(job.architecture_response.disposition.action, "resolved");
      assert.deepEqual(job.sprint_delegation.technical_result, technicalResult);
      assert.equal(requiresEvidenceReconciliation(job), true);
      assert.equal(job.execution_admission, undefined);
      assert.equal(job.validation_feedback, undefined);
      assert.equal(f.base.invocations, 1);
      assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, checkpoint.last_completed_turn);
      await f.recreate().tick();
      await f.recovery.tick();
      job = (await f.ledger()).jobs[0];
      assert.equal(job.status, "resumed");
      assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
      assert.equal(f.base.invocations, 2);
      assert.equal(f.base.integrations, 1);
      assert.equal((await f.ledger()).execution_id, "EXEC");
      assert.equal(f.base.events.some(event => event.type.includes("owner_decision_required")), false);
    } finally { await f.close(); }
  }
});

test("paused AM responses rejected only for missing receipts are revalidated without calling AM again", async () => {
  const f = await fixtureFor();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger(), job = ledger.jobs[0];
      job.ticket_progress ??= {};
      job.ticket_progress.failure_classification = await createBlockerFailureClassification({ readFailureEvidence: f.readFailureEvidence })(job, f.base.workspace);
      job.status = "cancelled";
      job.outcome_reason = "owner_cancelled";
      job.validation_feedback = [{ path: "/action", reason: "failure_evidence_incomplete" }];
      job.disposition_attempts.push({ stage: "architecture_manager", status: "rejected",
        response: blockerResponseEvidence(architectureAnswer(f.resolution)), validation_errors: job.validation_feedback });
      ledger.cancelled = true;
      await f.base.store.save("blocker.recovery", ledger);
      const checkpoint = await f.base.checkpoints.load("TASK");
      await f.base.checkpoints.save({ ...checkpoint, blocker_recovery: { ...checkpoint.blocker_recovery, status: "cancelled" } });
    });
    await f.recreate().resumeTicket({ projectId: "P", ticketId: "TASK" });
    await f.recovery.tick();
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.architecture_response.disposition.action, "resolved");
    assert.equal(job.validation_feedback, undefined);
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});

test("receipt gaps cannot excuse invalid authority, stale source, incomplete answers or denied file reads", async () => {
  const f = await fixtureFor();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    const job = (await f.ledger()).jobs[0];
    job.ticket_progress ??= {};
    job.ticket_progress.failure_classification = await createBlockerFailureClassification({ readFailureEvidence: f.readFailureEvidence })(job, f.base.workspace);
    const value = architectureAnswer(f.resolution);
    const options = { job, plan: {}, architecture: { basis, markdown: quote }, fileService: f.base.fileService, projectRoot: f.base.workspace.projectRoot };
    for (const [change, reason] of [
      [{ action: "approved" }, "action_invalid"],
      [{ grant_tool_permission: true }, "additional_property"],
      [{ architecture_basis: { ...basis, revision: 2 } }, "identity_mismatch"],
      [{ boundary_assessment: { ...assessment, changes_security_policy: true } }, "boundary_not_preserved"],
      [{ evidence: [{ ...f.evidence, sha256: "b".repeat(64) }] }, "evidence_stale"],
      [{ technical_result: { ...technicalResult, verification_steps: [] } }, "technical_result_incomplete"],
      [{ technical_result: { ...technicalResult, admission: { status: "unresolved", rationale: "Permission is still missing." } } }, "admission_unresolved"],
      [{ authority_scope: "sprint" }, "failure_evidence_incomplete"]
    ]) {
      await assert.rejects(validateBlockerDisposition({ ...value, ...change }, options), error => error.validation_errors[0].reason === reason);
    }
    await assert.rejects(validateBlockerDisposition(value, { ...options, fileService: { readFile: async () => {
      throw Object.assign(new Error("File role cannot read this source."), { code: "FILE_ROLE_FORBIDDEN" });
    } } }), { code: "FILE_ROLE_FORBIDDEN" });
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});
