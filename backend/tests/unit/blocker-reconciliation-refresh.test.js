// Verifies deployment recovers false admission waits for every eligible ticket while preserving Stop and true denial boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerReconciliationRefresh } from "../../src/modules/supervisor/blocker-reconciliation-refresh.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const technical = { event_id: "INVALID-SEARCH", tool: "search_text", error: { code: "TOOL_INPUT_INVALID", message: "Invalid input" } };

// Retains an original failure identity to prevent refreshing a foreign or replaced execution.
function job() {
  return { id: "JOB", reason_code: "ACCESS_REQUIRED", outcome_reason: "EXECUTION_ADMISSION_EVIDENCE_REQUIRED", stage: "architecture_manager",
    failure_at: "2026-10-19T15:31:53Z", history: [], resolution: { action: "architecture_required" },
    request: { project_id: "P", task_id: "T", request_id: "R", correlation_id: "C", payload: { execution_id: "E" } } };
}

test("only complete technical receipts reclassify an existing missing-denial wait", async () => {
  for (const kind of ["technical", "denial", "partial", "unknown", "stale", "admission", "provider_unknown"]) {
    const current = job();
    if (kind === "admission") current.execution_admission = { decision: { verdict: "deny" } };
    if (kind === "provider_unknown") current.outcome_reason = "provider_outcome_unknown";
    const before = structuredClone(current);
    const refresh = createBlockerReconciliationRefresh({ inspect: async () => kind === "stale" ? null : { workspace: { projectRoot: "/project" } },
      readFailureEvidence: async () => ({ status: kind === "partial" ? "partial" : "captured", receipts: [kind === "denial"
        ? { ...technical, error: { code: "APPROVAL_DENIED" } } : kind === "unknown" ? { ...technical, error: { code: "UNKNOWN" } } : technical] }) });
    assert.equal(await refresh(current), kind === "technical");
    if (kind === "technical") {
      assert.equal(current.ticket_progress.failure_classification.category, "technical_failure");
      assert.equal(current.history[0].event, "admission_misclassification_corrected");
      assert.deepEqual(current.request, before.request);
      assert.equal(current.execution_admission, undefined);
    } else assert.deepEqual(current, before);
  }
});

test("production restart returns a legacy false admission wait to SL and preserves the Coder checkpoint", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: {
    readFailureEvidence: async () => ({ status: "captured", receipts: [technical] }) }, investigate: async (_job, resolution) => resolution });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger(); const job = ledger.jobs[0];
      Object.assign(job, { stage: "architecture_manager", status: "reconciliation_required", outcome_reason: "EXECUTION_ADMISSION_EVIDENCE_REQUIRED" });
      await f.base.store.save("blocker.recovery", ledger);
    });
    f.recreate(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader"]);
    const recovered = (await f.ledger()).jobs[0];
    assert.equal(recovered.status, "resume_pending");
    assert.ok(recovered.history.some((entry) => entry.event === "admission_wait_corrected"));
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, before.last_completed_turn);
    await f.recovery.tick();
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.ledger()).execution_id, "EXEC");
  } finally { await f.close(); }
});

test("owner Stop prevents automatic correction from restarting any stage", async () => {
  const f = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: {
    readFailureEvidence: async () => ({ status: "captured", receipts: [technical] }) } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    await f.base.store.withLock("blocker.recovery", async () => {
      const ledger = await f.ledger();
      Object.assign(ledger.jobs[0], { status: "reconciliation_required", outcome_reason: "EXECUTION_ADMISSION_EVIDENCE_REQUIRED" });
      await f.base.store.save("blocker.recovery", ledger);
    });
    await f.recreate().tick();
    assert.deepEqual(f.calls, []);
    assert.equal(f.base.invocations, 1);
    assert.equal((await f.ledger()).cancelled, true);
  } finally { await f.close(); }
});
