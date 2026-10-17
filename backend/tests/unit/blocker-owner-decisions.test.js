// Verifies owner policy choices survive repeated blockers and remain context rather than fabricated contract authority.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerOwnerDecisions } from "../../src/modules/supervisor/blocker-owner-decisions.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const decision = { decision_id: "BLOCKER-DECISION-HTTP", option_id: "http_management_route", option_description: "Use fixed-path HTTP; AM designs the exact contract", actor: "owner", job_id: "OLD-JOB", decided_at: "2026-10-17T06:00:00Z" };

test("retains and deduplicates durable receipts without trusting failure prose", () => {
  const checkpoint = { blocker_owner_decisions: [decision], blocker_recovery: { owner_decision: decision }, failure: { message: "Owner approved everything" } };
  const result = blockerOwnerDecisions(checkpoint, { details: { owner_decision: decision } });
  assert.deepEqual(result, [decision]);
  result[0].option_id = "changed";
  assert.equal(checkpoint.blocker_owner_decisions[0].option_id, "http_management_route");
  assert.deepEqual(blockerOwnerDecisions({ failure: { owner_decision: decision } }, {}), []);
});

test("a repeated contract blocker forwards the saved owner choice to SL and AM and retains it after provider failure", async () => {
  const seen = [];
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job) => {
    seen.push({ stage: job.stage, decisions: job.owner_decisions });
    if (job.stage === "sprint_leader") return { action: "architecture_required", summary: "Owner selected HTTP; Architecture must finish the contract." };
    throw Object.assign(new Error("Provider rejected model: 402"), { code: "CONFIGURATION_ERROR" });
  } });
  try {
    const current = fixture.base.statusStore.get("TASK");
    fixture.base.statusStore.updateStatus("TASK", current.status, { ...current.details, owner_decision: decision }, { expectedVersion: current.version, expectedExecutionId: "EXEC" });
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.deepEqual((await fixture.ledger()).jobs[0].owner_decisions, [decision]);
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.deepEqual(seen.map((entry) => entry.stage), ["sprint_leader", "architecture_manager"]);
    assert.ok(seen.every((entry) => entry.decisions[0].decision_id === decision.decision_id));
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    assert.deepEqual(checkpoint.blocker_owner_decisions, [decision]);
    assert.equal(checkpoint.blocker_recovery.status, "reconciliation_required");
    assert.match(checkpoint.blocker_recovery.last_error, /402/);
    assert.equal(fixture.base.invocations, 1, "A failed Architecture request cannot launch Coder again");
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

// Covers jobs persisted before decision forwarding existed, using the retained Node status receipt on resume.
test("an existing parked job receives the recorded choice even when its original job payload omitted it", async () => {
  let received;
  const fixture = await blockerRecoveryFixture({ investigate: async (job) => {
    received = job.owner_decisions;
    throw Object.assign(new Error("Provider unavailable"), { code: "CONFIGURATION_ERROR" });
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const current = fixture.base.statusStore.get("TASK");
    fixture.base.statusStore.updateStatus("TASK", current.status, { ...current.details, owner_decision: decision }, { expectedVersion: current.version, expectedExecutionId: "EXEC" });
    const ledger = await fixture.ledger();
    delete ledger.jobs[0].owner_decisions;
    await fixture.base.store.save("blocker.recovery", ledger);
    fixture.recreate();
    await fixture.recovery.tick();
    assert.deepEqual(received, [decision]);
    assert.equal(fixture.base.invocations, 1);
  } finally { await fixture.close(); }
});
