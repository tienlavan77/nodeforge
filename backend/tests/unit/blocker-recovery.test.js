// Verifies reusable SL/Architecture routing, finite recovery and exact checkpoint resume rather than ticket-specific resets.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const proposal = { action: "owner_required", summary: "A new public contract needs an owner decision.",
  escalation: { boundary: "explicit_owner_guardrail", rationale: "Changing the existing approved contract exceeds delegated implementation authority.", authority_quote: "Reuse backend/src/handler.js under the existing approved contract." }, proposal: {
  title: "Project catalog contract", options: [{ id: "existing", description: "Retain the current transport and defer the new public API." },
    { id: "new", description: "Approve the proposed add/remove/list request and response contract, compatibility and verification requirements." }], recommended_option_id: "existing" } };

test("blocked Coder automatically dispatches SL then Architecture and resumes the same checkpoint", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.equal((await fixture.base.checkpoints.load("TASK")).phase, "blocker_triage_pending");
    await fixture.recovery.tick();
    await fixture.recreate().tick();
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    await fixture.base.checkpoints.save({ ...checkpoint, thread_id: "PRESERVED", last_completed_turn: 15 });
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
    assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
    const completed = await fixture.base.checkpoints.load("TASK");
    assert.equal(completed.thread_id, "PRESERVED");
    assert.equal(completed.last_completed_turn, 15);
    assert.equal(completed.blocker_recovery.disposition.guidance, fixture.resolution.guidance);
    assert.deepEqual(completed.stage_progress.map((entry) => [entry.stage, entry.status]), [
      ["coder", "blocked"],
      ["sprint_leader", "completed"],
      ["architecture_manager", "completed"],
      ["coder", "resumed_from_blocker"]
    ]);
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
  } finally { await fixture.close(); }
});

test("new contract proposal is prepared automatically, published once and never auto-approved", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job) => job.stage === "sprint_leader" ? { action: "architecture_required", summary: "Verify compatible management transport." } : proposal });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    await Promise.all([fixture.recovery.tick(), fixture.recreate().tick()]);
    await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
    assert.equal(fixture.base.events.filter((event) => event.type === "task.blocker.owner_decision_required").length, 1);
    assert.deepEqual((await fixture.base.checkpoints.load("TASK")).blocker_recovery.proposal, proposal.proposal);
    assert.equal(fixture.base.statusStore.get().status, "needs_human_review");
  } finally { await fixture.close(); }
});

test("restart capture and two workers deduplicate one failure and one stage invocation", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const first = fixture.recovery;
    const second = fixture.recreate();
    await second.recover(); await second.recover();
    await Promise.all([first.tick(), second.tick()]);
    assert.equal(fixture.calls.filter((stage) => stage === "sprint_leader").length, 1);
    assert.equal((await fixture.ledger()).jobs.length, 1);
  } finally { await fixture.close(); }
});

test("source changes, owner cancellation and replacement execution invalidate pending investigations", async () => {
  for (const mutation of ["staleSource", "replaceExecution", "revokePlan"]) {
    const fixture = await blockerRecoveryFixture();
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      fixture.base[mutation](); await fixture.recovery.tick();
      assert.equal(fixture.calls.length, 0);
      assert.equal((await fixture.ledger()).jobs[0].status, "cancelled");
      assert.equal(fixture.base.invocations, 1);
    } finally { await fixture.close(); }
  }
});

test("Stop cancels a parked investigation durably without clearing its checkpoint", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await assert.rejects(fixture.recovery.stopTicket({ projectId: "OTHER", ticketId: "TASK" }));
    await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
    await fixture.recreate().tick();
    assert.equal(fixture.calls.length, 0);
    assert.equal((await fixture.ledger()).cancelled, true);
    assert.equal((await fixture.base.checkpoints.load("TASK")).status, "blocked");
  } finally { await fixture.close(); }
});

test("malformed or hallucinated authority and stale checksums never resume Coder", async () => {
  for (const change of [{ action: "approved" }, { authority_quote: "Invented authority that was never approved" },
    { evidence: [{ path: "backend/src/handler.js", sha256: "0".repeat(64) }] }, { evidence: [{ path: "../secret", sha256: "0".repeat(64) }] }]) {
    const fixture = await blockerRecoveryFixture({ investigate: async (_job, resolution) => ({ ...resolution, ...change }) });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      for (let turn = 0; turn < 6; turn += 1) await fixture.recovery.tick();
      assert.equal(fixture.base.invocations, 1);
      assert.equal(fixture.base.integrations, 0);
      assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    } finally { await fixture.close(); }
  }
});

test("access and security blockers cannot be cleared by agent narrative", async () => {
  for (const reason of ["ACCESS_REQUIRED", "SECURITY_RISK"]) {
    const fixture = await blockerRecoveryFixture({ reason });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await fixture.recovery.tick(); await fixture.recovery.tick();
      assert.equal(fixture.base.invocations, 1);
      await fixture.recovery.tick();
      assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    } finally { await fixture.close(); }
  }
});

test("unknown provider failure and persisted invoking stage never replay after restart", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => { throw Object.assign(new Error("Unknown provider outcome"), { code: "BLOCKER_PROVIDER_UNKNOWN" }); } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recreate().tick();
    assert.equal(fixture.calls.length, 1);
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
  } finally { await fixture.close(); }
});

test("execution-wide call budget and deadline do not reset after restart", async () => {
  for (const limits of [{ maxCalls: 1 }, { deadlineMs: 1000 }]) {
    const fixture = await blockerRecoveryFixture({ limits });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      if (limits.deadlineMs) fixture.advance(1000);
      await fixture.recovery.tick(); await fixture.recreate().tick(); await fixture.recovery.tick();
      assert.equal(fixture.base.invocations, 1);
      assert.ok(fixture.calls.length <= 1);
      assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    } finally { await fixture.close(); }
  }
});

test("unavailable roles wait without consuming provider calls until the deadline", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => { throw Object.assign(new Error("Role busy"), { not_started: true }); } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).calls, 0);
    fixture.advance(600_000); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
  } finally { await fixture.close(); }
});

test("repeated blockers cannot reset the execution-wide budget by creating new failure records", async () => {
  const fixture = await blockerRecoveryFixture({ repeatBlock: true });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 12; turn += 1) await fixture.recreate().tick();
    const ledger = await fixture.ledger();
    assert.equal(fixture.base.invocations, 3);
    assert.equal(ledger.resumes, 2);
    assert.equal(ledger.calls, 4);
    assert.equal(ledger.jobs.at(-1).status, "reconciliation_required");
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("a crash after the stage claim never redispatches that provider invocation", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const ledger = await fixture.ledger();
    ledger.jobs[0].status = "invoking";
    ledger.calls = 1;
    await fixture.base.store.withLock("blocker.recovery", () => fixture.base.store.save("blocker.recovery", ledger));
    await fixture.recreate().tick();
    assert.equal(fixture.calls.length, 0);
    fixture.advance(600_000);
    await fixture.recovery.tick();
    assert.equal(fixture.calls.length, 0);
    assert.equal((await fixture.ledger()).jobs[0].outcome_reason, "provider_outcome_unknown");
    await assert.rejects(fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  } finally { await fixture.close(); }
});

test("stopped or failed AM stage resumes at architecture_manager in the same ticket checkpoint without rerunning SL or Coder", async () => {
  let failAmOnce = true;
  const fixture = await blockerRecoveryFixture({
    investigate: async (job, resolution) => {
      if (job.stage === "sprint_leader") return { action: "architecture_required", summary: "Escalate to AM." };
      if (failAmOnce) {
        failAmOnce = false;
        throw Object.assign(new Error("Temporary AM stage failure"), { code: "AM_STAGE_FAILED" });
      }
      return resolution;
    }
  });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    const paused = await fixture.base.checkpoints.load("TASK");
    assert.equal(paused.blocker_recovery.status, "reconciliation_required");
    assert.equal(paused.stage_progress.at(-1).stage, "architecture_manager");
    assert.equal(paused.stage_progress.at(-1).status, "reconciliation_required");
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager"]);

    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.resumed_stage, "architecture_manager");

    await fixture.recovery.tick();
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "architecture_manager"]);
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
    const finalCheckpoint = await fixture.base.checkpoints.load("TASK");
    assert.equal(finalCheckpoint.status, "completed");
  } finally { await fixture.close(); }
});
