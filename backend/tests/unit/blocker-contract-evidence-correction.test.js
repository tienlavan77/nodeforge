// Reproduces a Sprint Leader clearing a contract-labelled verification blocker
// without approved evidence. Node must return actionable correction feedback,
// preserve the contract gate and checkpoint, and stop repeated invalid answers.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

test("missing contract evidence offers a correction turn without resuming Coder", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    const first = (await fixture.ledger()).jobs[0];
    assert.equal(first.status, "pending");
    assert.equal(first.validation_feedback[0].path, "/action");
    assert.equal(first.validation_feedback[0].reason, "approved_contract_evidence_missing");
    assert.match(first.validation_feedback[0].expected, /reconciliation_required.*baseline/);
    assert.equal(first.disposition_attempts.at(-1).status, "rejected");
    assert.equal(fixture.base.invocations, 1);
    // The same uncorrected disposition must not create an infinite agent loop.
    for (let step = 0; step < 6 && (await fixture.ledger()).jobs[0].status === "pending"; step += 1) await fixture.recovery.tick();
    const repeated = (await fixture.ledger()).jobs[0];
    assert.equal(repeated.outcome_reason, "disposition_correction_no_progress");
    assert.notEqual(repeated.status, "resume_pending");
    assert.equal(fixture.base.invocations, 1);
    assert.equal((await fixture.base.checkpoints.load("TASK")).status, "blocked");
  } finally { await fixture.close(); }
});
