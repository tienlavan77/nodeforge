// Verifies authority questions reach AM through Node without granting tools, replaying Coder or looping the same denial.
import assert from "node:assert/strict";
import test from "node:test";
import { assignAuthorityConsultation } from "../../src/modules/supervisor/blocker-authority-consultation.js";
import { scheduleTechnicalReconciliation } from "../../src/modules/supervisor/blocker-technical-reconciliation.js";
import { returnArchitectureResponse } from "../../src/modules/supervisor/blocker-architecture-response.js";
import { createBlockerReconciliationRefresh } from "../../src/modules/supervisor/blocker-reconciliation-refresh.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const recoveryOptions = { readFailureEvidence: async () => ({ status: "captured", receipts: [
  { event_id: "DENIAL", tool: "edit_diff", arguments: { path: "backend/src/handler.js" }, error: { code: "APPROVAL_DENIED", message: "Denied original mutation." } }
] }) };
const waiting = { action: "reconciliation_required", summary: "A tool denial conflicts with the approved contract.",
  guidance: "Compare the existing contract and the original denial before deciding how to continue.",
  reconciliation: { kind: "execution_admission", prerequisite: "Interpret the current denied operation within approved scope.",
    completed_checks: ["The approved contract exists, but the actual mutation was denied."], next_check: "Compare retained authority and the precise operation.",
    waiting_for: [{ owner: "external", operation: "inspect", question: "Resolve whether the retained denial requires a new permission decision." }] } };

// Supplies a stable execution-bound denial and checkpoint without inventing approval for its operation.
function job() {
  return { id: "J", stage: "sprint_leader", status: "pending", reason_code: "SECURITY_RISK", failure_at: "2026-10-23T00:12:52Z", history: [],
    execution_admission: { sha256: "denial-one", decision: { verdict: "deny" } },
    request: { project_id: "P", task_id: "T", payload: { execution_id: "E" }, ticket: {} } };
}

test("external admission wait becomes a bounded AM question and preserves denial/request bytes", () => {
  const current = job(), before = structuredClone(current);
  scheduleTechnicalReconciliation(current, waiting, 10);
  assert.equal(current.stage, "architecture_manager");
  assert.equal(current.status, "pending");
  assert.equal(current.resolution.action, "architecture_required");
  assert.match(current.resolution.guidance, /do not dispatch Coder/);
  assert.deepEqual(current.execution_admission, before.execution_admission);
  assert.deepEqual(current.request, before.request);
  assert.deepEqual(current.authority_consultations[0].original_resolution, waiting);
  assert.equal(current.coder_exchange, undefined);
});

test("AM answers return to SL and rewording cannot repeat a source-bound consultation after restart", () => {
  const current = job();
  scheduleTechnicalReconciliation(current, waiting, 10);
  assert.equal(returnArchitectureResponse(current, waiting, 20), true);
  assert.equal(current.stage, "sprint_leader");
  assert.equal(current.authority_consultations[0].status, "answered");
  const restarted = structuredClone(current);
  scheduleTechnicalReconciliation(restarted, { ...waiting, summary: "Different wording for the same admission." }, 30);
  assert.equal(restarted.stage, "sprint_leader");
  assert.equal(restarted.status, "notification_pending");
  assert.equal(restarted.authority_consultations.length, 1);
  assert.equal(restarted.execution_admission.decision.verdict, "deny");
});

test("new denial requires a new AM answer while an older AM contract cannot settle the later denial", () => {
  const current = job();
  current.architecture_response = { answered_at: Date.parse(current.failure_at) - 1, execution_id: "E", disposition: { action: "resolved" } };
  assert.equal(assignAuthorityConsultation(current, waiting, 10), true);
  returnArchitectureResponse(current, waiting, 20);
  current.execution_admission.sha256 = "denial-two";
  assert.equal(assignAuthorityConsultation(current, waiting, 30), true);
  assert.equal(current.authority_consultations.length, 2);
});

test("an AM answer on this failure and execution is consumed instead of another automatic consultation", () => {
  const current = job();
  current.architecture_response = { answered_at: Date.parse(current.failure_at) + 1, execution_id: "E", disposition: waiting };
  assert.equal(assignAuthorityConsultation(current, waiting, 10), false);
  current.architecture_response.execution_id = "OTHER";
  assert.equal(assignAuthorityConsultation(current, waiting, 20), true);
});

test("dependency/operator waits and explicit Coder evidence retain their existing owners", () => {
  for (const work of [
    { ...waiting.reconciliation, kind: "dependency" },
    { ...waiting.reconciliation, kind: "file_claim" },
    { ...waiting.reconciliation, waiting_for: [{ owner: "coder", operation: "inspect", question: "Inspect the missing file." }] }
  ]) assert.equal(assignAuthorityConsultation(job(), { ...waiting, reconciliation: work }, 1), false);
  const current = job(); current.stage = "architecture_manager";
  assert.equal(assignAuthorityConsultation(current, waiting, 1), false);
});

test("legacy parked admission waits are assigned after authority validation and log the actual recipient", async () => {
  const current = job(); Object.assign(current, { status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence", resolution: waiting });
  const logs = [];
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: {} }), projectLogger: (event) => logs.push(event) });
  assert.equal(await refresh(current), true);
  assert.equal(current.stage, "architecture_manager");
  assert.equal(logs[0].event_name, "supervisor.blocker_authority_consultation");
  const stale = job(); Object.assign(stale, { outcome_reason: "technical_reconciliation_waiting_for_evidence", resolution: waiting });
  const before = structuredClone(stale);
  assert.equal(await createBlockerReconciliationRefresh({ inspect: async () => null })(stale), false);
  assert.deepEqual(stale, before);
});

test("real recovery calls SL then AM then SL while preserving the denied checkpoint and preventing an automatic cycle", async () => {
  const f = await blockerRecoveryFixture({ reason: "SECURITY_RISK", recoveryOptions, investigate: async () => waiting });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const before = await f.base.checkpoints.load("TASK");
    for (let tick = 0; tick < 5; tick += 1) await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal(f.base.invocations, 1);
    assert.equal((await f.ledger()).jobs[0].authority_consultations[0].status, "answered");
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, before.last_completed_turn);
    f.recreate();
    for (let tick = 0; tick < 3; tick += 1) await f.recovery.tick();
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test("restart routes an existing parked wait directly to AM and owner Stop prevents it", async () => {
  for (const stopped of [false, true]) {
    const f = await blockerRecoveryFixture({ reason: "SECURITY_RISK", recoveryOptions, investigate: async () => waiting });
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      if (stopped) await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      await f.base.store.withLock("blocker.recovery", async () => {
        const ledger = await f.ledger();
        Object.assign(ledger.jobs[0], { stage: "sprint_leader", status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence", resolution: waiting });
        await f.base.store.save("blocker.recovery", ledger);
      });
      f.recreate(); await f.recovery.tick();
      assert.deepEqual(f.calls, stopped ? [] : ["architecture_manager"]);
      assert.equal(f.base.invocations, 1);
    } finally { await f.close(); }
  }
});

test("refreshing admission commentary cannot masquerade as a new denial or launch another AM call", () => {
  const current = job();
  current.execution_admission.receipts = [{ event_id: "ORIGINAL", error: { code: "APPROVAL_DENIED" } }];
  assignAuthorityConsultation(current, waiting, 1);
  returnArchitectureResponse(current, waiting, 2);
  current.execution_admission.sha256 = "refreshed-admission-same-denial";
  current.execution_admission.findings = ["More commentary without a different original denial."];
  assert.equal(assignAuthorityConsultation(current, waiting, 3), false);
  assert.equal(current.authority_consultations.length, 1);
});
