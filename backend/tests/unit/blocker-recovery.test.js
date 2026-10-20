// Verifies reusable SL/Architecture routing, finite recovery and exact checkpoint resume rather than ticket-specific resets.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const proposal = { action: "owner_required", summary: "A new public contract needs an owner decision.",
  boundary_assessment: { rationale: "Adding a new public management contract changes the approved ticket contract.",
    changes_structure: false, changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: true },
  escalation: { boundary: "explicit_owner_guardrail", rationale: "Changing the existing approved contract exceeds delegated implementation authority.", authority_quote: "Reuse backend/src/handler.js under the existing approved contract." }, proposal: {
  title: "Project catalog contract", options: [{ id: "existing", description: "Retain the current transport and defer the new public API." },
    { id: "new", description: "Approve the proposed add/remove/list request and response contract, compatibility and verification requirements." }], recommended_option_id: "existing" } };

test("blocked Coder automatically dispatches SL then Architecture then SL and resumes the same checkpoint", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.equal((await fixture.base.checkpoints.load("TASK")).phase, "blocker_triage_pending");
    await fixture.recovery.tick();
    await fixture.recreate().tick();
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    await fixture.base.checkpoints.save({ ...checkpoint, thread_id: "PRESERVED", last_completed_turn: 15 });
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    await fixture.recovery.tick();
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
      ["sprint_leader", "completed"],
      ["coder", "resumed_from_blocker"]
    ]);
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
  } finally { await fixture.close(); }
});

test("new contract proposal is prepared automatically, published once and never auto-approved", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job, resolution) => job.stage === "sprint_leader" ? { action: "architecture_required", summary: "Verify compatible management transport." } : { ...proposal, evidence: resolution.evidence } });
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
      fixture.advance(600_000); await fixture.recovery.tick();
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
      for (let turn = 0; turn < 6; turn += 1) await fixture.recovery.tick();
      fixture.advance(600_000); await fixture.recovery.tick();
      assert.equal(fixture.base.invocations, 1);
      assert.equal(fixture.base.integrations, 0);
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

test("stopped or failed AM stage resumes at architecture_manager in the same ticket checkpoint without rerunning SL or Coder", async () => {
  let failAmOnce = true;
  const fixture = await blockerRecoveryFixture({
    investigate: async (job, resolution) => {
      if (job.stage === "sprint_leader" && !job.architecture_response) return { action: "architecture_required", summary: "Escalate to AM." };
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
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "architecture_manager", "sprint_leader"]);
    await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
    const finalCheckpoint = await fixture.base.checkpoints.load("TASK");
    assert.equal(finalCheckpoint.status, "completed");
  } finally { await fixture.close(); }
});

test("an interrupted unknown-provider stage reconciles so a later resume re-arms without replaying the provider", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => { throw Object.assign(new Error("Unknown provider outcome"), { code: "BLOCKER_PROVIDER_UNKNOWN" }); } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    const parked = await fixture.base.checkpoints.load("TASK");
    assert.equal(parked.blocker_recovery.status, "reconciliation_required");
    assert.ok(["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(parked.blocker_recovery.reason));
    const beforeCalls = fixture.calls.length;
    // An explicit RUN now self-heals: it reconciles the interrupted read-only provider stage under audit, then re-arms it,
    // instead of parking the owner on a 409. The resume itself must never replay the provider.
    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed, true);
    assert.ok(["sprint_leader", "architecture_manager"].includes(resumed.resumed_stage));
    assert.equal(fixture.calls.length, beforeCalls, "reconcile-and-re-arm must never replay the provider");
  } finally { await fixture.close(); }
});

test("an explicit reconcile clears the unknown-provider reason so a later RUN re-arms the stage", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => { throw Object.assign(new Error("Unknown provider outcome"), { code: "BLOCKER_PROVIDER_UNKNOWN" }); } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    const beforeCalls = fixture.calls.length;
    const result = await fixture.recovery.reconcileTicket({ projectId: "P", ticketId: "TASK", actor: "project_owner" });
    assert.equal(result.status, "reconciled");
    assert.equal(fixture.calls.length, beforeCalls, "reconciliation must never replay the provider");
    assert.equal((await fixture.ledger()).jobs.at(-1).outcome_reason, "provider_interrupted_reconciled");
    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed, true);
  } finally { await fixture.close(); }
});

test("reconcile rejects a stage that is not an unknown-provider reconciliation and is idempotent after clearing", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    // Nothing parked at reconciliation yet.
    await assert.rejects(fixture.recovery.reconcileTicket({ projectId: "P", ticketId: "TASK" }), /unknown-provider blocker stage/);
  } finally { await fixture.close(); }
});

test("resuming salvages the persisted AM answer and returns it to SL without repeating the AM provider call", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.base.store.withLock("blocker.recovery", async () => {
      const [ledger] = await fixture.base.store.list("blocker.recovery");
      const job = ledger.jobs[0];
      ledger.calls = 2;
      job.stage = "architecture_manager";
      job.status = "reconciliation_required";
      job.outcome_reason = "CONFIGURATION_ERROR";
      job.disposition_attempts = [{ stage: "architecture_manager", status: "rejected", received_at: 1,
        response: { text: `Based on my investigation:\n\n\`\`\`json\n${JSON.stringify({ ...fixture.resolution, boundary_assessment: null, architecture_basis: null })}\n\`\`\`` },
        validation_errors: [{ path: "/", reason: "json_invalid", message: "Unexpected token" }] }];
      await fixture.base.store.save("blocker.recovery", ledger);
    });
    const cp = await fixture.base.checkpoints.load("TASK");
    await fixture.base.checkpoints.save({ ...cp, phase: "blocker_reconciliation_required", stage_progress: [{ stage: "architecture_manager", status: "reconciliation_required" }],
      blocker_recovery: { job_id: (await fixture.ledger()).jobs[0].id, status: "reconciliation_required", reason: "CONFIGURATION_ERROR" } });
    let providerCalls = 0;
    fixture.recreate({ investigate: async (job) => { assert.equal(job.stage, "sprint_leader"); providerCalls += 1; return fixture.resolution; } });
    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed, true);
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    assert.equal(providerCalls, 1);
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resumed");
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});
