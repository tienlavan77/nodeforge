// Verifies automatic blocker recovery preserves checkpoint authority at RUN, Stop and failed resume boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { preflightBlockerContract } from "../../src/modules/supervisor/blocker-contract-preflight.js";
import { BASIS } from "../fixtures/coder-production-recovery-fixture.js";

test("a rejected transactional resume restores the parked checkpoint without invoking Coder", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let step = 0; step < 5 && (await fixture.ledger()).jobs[0].status !== "resume_pending"; step += 1) await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "resume_pending");
    fixture.base.statusStore.resumeBlockedExecution = () => { throw Object.assign(new Error("Resume CAS rejected"), { code: "STATUS_CONFLICT" }); };
    await fixture.recovery.tick();
    const checkpoint = await fixture.base.checkpoints.load("TASK");
    assert.equal(checkpoint.status, "blocked");
    assert.equal(checkpoint.failure.code, "CODER_BLOCKED");
    assert.equal(fixture.base.statusStore.get().status, "needs_human_review");
    assert.equal(fixture.base.invocations, 1);
    await fixture.recovery.tick();
    assert.equal(fixture.base.events.filter((event) => event.type === "task.blocker.reconciliation_required").length, 1);
  } finally { await fixture.close(); }
});

test("RUN including fresh does not replace a triage execution and Stop cancels its pending work", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const dispatch = createTicketRunDispatch({ blockerRecovery: fixture.recovery, ticketStatusStore: fixture.base.statusStore,
      disposition: { get: async () => null }, intake: { open: async () => ({ ticket: fixture.ticket }) },
      sprintRegistry: fixture.base.registry });
    for (const fresh of [false, true]) {
      const result = await dispatch({ projectId: "P", ticketId: "TASK", dependencyExpectations: [], fresh });
      assert.equal(result.reason, "blocker_recovery_pending");
      assert.equal(fixture.base.statusStore.get().details.execution_id, "EXEC");
    }
    await assert.rejects(dispatch.stop({ projectId: "OTHER", ticketId: "TASK" }), { code: "TICKET_NOT_RUNNING" });
    assert.equal((await dispatch.stop({ projectId: "P", ticketId: "TASK" })).status, "stopping");
    await fixture.recovery.tick();
    assert.equal(fixture.calls.length, 0);
    assert.equal((await fixture.base.checkpoints.load("TASK")).blocker_recovery.status, "cancelled");
  } finally { await fixture.close(); }
});

test("contract preflight propagates a storage failure instead of misclassifying it as a contract decision", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const ref = { ...fixture.evidence, authority_quote: fixture.ticket.objective };
    const ticket = { ...fixture.ticket, execution_policy: { requires_existing_contract: true, contract_evidence: [ref] } };
    const error = Object.assign(new Error("Source storage offline"), { code: "EIO" });
    await assert.rejects(preflightBlockerContract({ ticket, task_id: "TASK", payload: { sprint_basis: BASIS } }, {
      sprintRegistry: { assertReady: async () => ({ plan: { content: { tickets: [ticket.id], ticket_specs: [ticket] } } }) },
      resolveTicketWorkspace: async () => ({ path: fixture.base.workspace.path ?? fixture.base.workspace.projectRoot, fileService: { readFile: async () => { throw error; } } })
    }), { code: "EIO" });
    assert.equal(await fixture.ledger(), undefined);
  } finally { await fixture.close(); }
});

test("an unknown resumed launch publishes reconciliation without rewriting the active checkpoint or replaying", async () => {
  const fixture = await blockerRecoveryFixture();
  let submissions = 0;
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    fixture.recreate({ submitTicket: async () => {
      submissions += 1;
      const current = fixture.base.statusStore.get();
      fixture.base.statusStore.updateStatus("TASK", "running", { ...current.details, launch_claim: { request_id: "UNKNOWN" } },
        { expectedVersion: current.version, expectedExecutionId: "EXEC" });
      throw Object.assign(new Error("Provider outcome unknown"), { code: "BLOCKER_PROVIDER_UNKNOWN" });
    } });
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(submissions, 1);
    assert.equal(fixture.base.statusStore.get().details.launch_claim.request_id, "UNKNOWN");
    assert.equal((await fixture.base.checkpoints.load("TASK")).phase, "blocker_resolved");
    assert.equal(fixture.base.events.filter((event) => event.type === "task.blocker.reconciliation_required").length, 1);
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
  } finally { await fixture.close(); }
});

test("Stop during a resumed Coder execution delegates to its actual provider cancellation", async () => {
  const fixture = await blockerRecoveryFixture();
  const stops = [];
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    fixture.recreate({ submitTicket: async () => { throw new Error("Unknown launch"); },
      stopExecution: async (input) => { stops.push(input); return { status: "stopping" }; } });
    const current = fixture.base.statusStore.get();
    fixture.base.statusStore.updateStatus("TASK", "running", current.details,
      { expectedVersion: current.version, expectedExecutionId: "EXEC" });
    assert.equal((await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" })).status, "stopping");
    assert.deepEqual(stops, [{ projectId: "P", ticketId: "TASK" }]);
    assert.equal((await fixture.ledger()).cancelled, true);
  } finally { await fixture.close(); }
});
