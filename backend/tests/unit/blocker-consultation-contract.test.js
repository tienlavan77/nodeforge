// Verifies optional technical consultation details reach AM once and field errors identify the actual contract mismatch.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateTechnicalReconciliation } from "../../src/modules/supervisor/blocker/blocker-technical-reconciliation.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker/blocker-recovery-contract.js";

const reconciliation = { kind: "technical_design", prerequisite: "Clarify the existing handler contract.",
  completed_checks: ["Located the approved handler."], next_check: "AM answers the specific compatibility question.",
  waiting_for: [{ owner: "architecture_manager", operation: "inspect", question: "Does existing handler composition allow this change?" },
    { owner: "coder", operation: "execute", question: "Implement after SL hands off the answer." }] };
const technical_result = { findings: ["Existing composition is sufficient."], implementation_steps: ["Continue the approved handler change."],
  verification_steps: ["Run the mapped handler test."], admission: { status: "within_existing_permissions", rationale: "No new permission or contract is needed." } };

test("SL technical consultation reaches AM once across restart and AM returns to SL before Coder resumes", async () => {
  const f = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (job.stage === "architecture_manager") {
      assert.equal(job.resolution.action, "architecture_required");
      assert.deepEqual(job.resolution.reconciliation, reconciliation);
      return { ...resolution, technical_result };
    }
    return job.architecture_response ? { ...resolution, technical_result }
      : { action: "architecture_required", summary: "Clarify existing handler composition.", guidance: reconciliation.waiting_for[0].question,
        reconciliation, evidence: resolution.evidence };
  } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].stage, "architecture_manager");
    assert.equal(f.base.invocations, 1);
    await f.recreate().tick();
    assert.equal((await f.ledger()).jobs[0].stage, "sprint_leader");
    assert.equal(f.base.invocations, 1);
    await f.recovery.tick();
    await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.ticket_progress.last_completed_turn, before.last_completed_turn);
  } finally { await f.close(); }
});

test("validation errors name action, kind, required text, unknown fields and bad waiting input precisely", () => {
  const cases = [
    [{ action: "owner_required", reconciliation }, "/action", "reconciliation_action_mismatch"],
    [{ action: "architecture_required", reconciliation: { ...reconciliation, kind: "unknown" } }, "/reconciliation/kind", "kind_invalid"],
    [{ action: "architecture_required", reconciliation: { ...reconciliation, next_check: "" } }, "/reconciliation/next_check", "text_invalid"],
    [{ action: "architecture_required", reconciliation: { ...reconciliation, completed_checks: [] } }, "/reconciliation/completed_checks", "checks_invalid"],
    [{ action: "architecture_required", reconciliation: { ...reconciliation, unexpected: true } }, "/reconciliation/unexpected", "additional_property"],
    [{ action: "architecture_required", reconciliation: { ...reconciliation, waiting_for: [{ owner: "unknown", question: "Clarify" }] } }, "/reconciliation/waiting_for/0", "waiting_input_invalid"]
  ];
  for (const [value, path, reason] of cases) assert.throws(() => validateTechnicalReconciliation(value, {}), (error) => {
    assert.equal(error.validation_errors[0].path, path);
    assert.equal(error.validation_errors[0].reason, reason);
    return true;
  });
});

test("AM cannot ask Architecture to consult itself using the expanded envelope", async () => {
  await assert.rejects(validateBlockerDisposition({ action: "architecture_required", summary: "Ask again", reconciliation },
    { job: { stage: "architecture_manager" } }), (error) => error.validation_errors[0].reason === "architecture_stage_terminal");
});

test("Stop before a queued AM consultation prevents its provider invocation", async () => {
  const f = await blockerRecoveryFixture({ investigate: async () => ({ action: "architecture_required", summary: "Ask AM once", reconciliation }) });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick();
    await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    await f.recreate().tick();
    assert.deepEqual(f.calls, ["sprint_leader"]);
    assert.equal((await f.ledger()).cancelled, true);
  } finally { await f.close(); }
});
