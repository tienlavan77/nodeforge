// Prevents unresolved technical prerequisites from cycling Coder through false Architecture resolutions.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { assertOwnerEscalation } from "../../src/modules/supervisor/blocker-decision-authority.js";

const technical = { action: "reconciliation_required", summary: "Another ticket still holds the required serving-handler claim.",
  guidance: "Reconcile the serving-handler claim and record the ownership-safe integration handoff before resuming Coder." };

test("AM returns unresolved findings to SL and unchanged reconciliation parks without relaunching Coder", async () => {
  const logs = [];
  const fixture = await blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: { projectLogger: (entry) => logs.push(entry) },
    investigate: async (job, resolution) => job.stage === "sprint_leader"
      ? job.architecture_response?.disposition ?? { action: "architecture_required", summary: "AM must reconcile the blocked serving-handler integration." }
      : { ...technical, evidence: resolution.evidence } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 3; turn += 1) await fixture.recovery.tick();
    for (let turn = 0; turn < 10; turn += 1) {
      await fixture.recreate().recover();
      await fixture.recovery.tick();
    }
    const ledger = await fixture.ledger();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
    assert.equal(ledger.resumes, 0);
    assert.equal(ledger.jobs.length, 1);
    assert.equal(ledger.jobs[0].status, "reconciliation_required");
    assert.equal(ledger.jobs[0].outcome_reason, "technical_reconciliation_no_progress");
    assert.equal(ledger.jobs[0].resolution.action, "reconciliation_required");
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    assert.equal(checkpoint.blocker_recovery.reason, "technical_reconciliation_no_progress");
    assert.equal(checkpoint.failure.code, "CODER_BLOCKED");
    assert.equal(fixture.base.events.filter((event) => event.type === "task.blocker.reconciliation_required").length, 1);
    assert.equal(fixture.base.events.some((event) => event.type === "task.blocker.owner_decision_required"), false);
    const notification = logs.find((entry) => entry.event_name === "ticket.blocker_reconciliation_required");
    assert(notification.message.includes(technical.summary));
    assert.equal(notification.message.includes("No valid disposition was established"), false);
  } finally { await fixture.close(); }
});

test("SL retains implementation reconciliation rather than escalating it automatically", async () => {
  const fixture = await blockerRecoveryFixture({ investigate: async () => technical });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.status, "pending");
    assert.equal(job.history[0].disposition.action, "reconciliation_required");
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    assert.equal(fixture.base.invocations, 1);
  } finally { await fixture.close(); }
});

test("a reconciled prerequisite resumes SL with the retained AM answer without resetting ticket execution", async () => {
  let cleared = false;
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => !cleared && job.stage === "sprint_leader"
    ? job.architecture_response?.disposition ?? { action: "architecture_required", summary: "AM must investigate a technical prerequisite." } : cleared ? { ...resolution, technical_result: { findings: ["Claim no longer held."], implementation_steps: ["Complete the approved handler."], verification_steps: ["Run handler tests."], admission: { status: "within_existing_permissions", rationale: "Existing permissions permit the handler change." } } } : technical });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 4; turn += 1) await fixture.recovery.tick();
    cleared = true;
    const resumed = await fixture.recovery.resumeTicket({ projectId: "P", ticketId: "TASK" });
    assert.equal(resumed.resumed_stage, "sprint_leader");
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader", "architecture_manager", "sprint_leader", "sprint_leader"]);
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
    assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
  } finally { await fixture.close(); }
});

test("AM must identify the unresolved prerequisite with bounded guidance", async () => {
  for (const guidance of [undefined, "", "x".repeat(8001)]) {
    await assert.rejects(validateBlockerDisposition({ ...technical, guidance }, { job: { stage: "architecture_manager" } }),
      { code: "BLOCKER_DISPOSITION_INVALID" });
  }
});

test("owner-escalation feedback offers technical reconciliation instead of forcing a false resolved response", () => {
  const quote = "Keep all existing serving-runtime paths, permissions and owner guardrails unchanged.";
  const value = { action: "owner_required", escalation: { boundary: "explicit_owner_guardrail", rationale: "A file claim still blocks this integration.", authority_quote: quote },
    boundary_assessment: { rationale: "No owner policy changes are required to reconcile the existing claim.", changes_structure: false,
      changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false } };
  assert.throws(() => assertOwnerEscalation(value, { job: { stage: "architecture_manager", request: { ticket: { objective: quote } } }, plan: {} }), (error) => {
    assert.equal(error.validation_errors[0].reason, "delegated_to_architecture");
    assert.match(error.message, /resolved only when the blocker is cleared/);
    assert.match(error.message, /otherwise action=reconciliation_required/);
    return true;
  });
});

test("technical reconciliation cannot attach stale source evidence", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(validateBlockerDisposition({ ...technical, evidence: [{ ...fixture.evidence, sha256: "0".repeat(64) }] }, {
      job: { stage: "architecture_manager" }, fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot
    }), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await fixture.close(); }
});

test("AM prompt allows unresolved technical outcomes instead of forcing all-false impact flags to resolved", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const worker = createBlockerRecoveryAgent({
      agentResolver: { resolveAvailable: () => ({ agent_id: "AM", role: "architecture_manager", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
      resolveTicketWorkspace: async () => fixture.base.workspace,
      gateways: { openaiSdkGateway: { execute: async ({ prompt }) => {
        assert.match(prompt, /otherwise reconciliation_required/);
        assert.match(prompt, /Never return resolved while saying the claim is still held/);
        assert.match(prompt, /there is no call quota/);
        return { text: JSON.stringify(technical) };
      } } }
    });
    const value = await worker({ id: "JOB", stage: "architecture_manager", request: { task_id: "TASK", ticket: fixture.ticket }, history: [] },
      { deadline: Date.now() + 5000 });
    assert.equal(value.action, "reconciliation_required");
  } finally { await fixture.close(); }
});
