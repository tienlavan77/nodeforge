// Verifies shared RUN resumes finding repairs from their retained turn after proven upstream execution replacement.
import assert from "node:assert/strict";
import test from "node:test";
import { reviewDependencyFixture } from "../fixtures/review-dependency-fixture.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { assertDependencySubmission } from "../../src/modules/supervisor/ticket/ticket-dependency-expectations.js";

// Exercises real SQLite status updates and the production shared RUN boundary without invoking an SDK.
test("RUN reconciles dependency replacement then resumes the exact repair checkpoint and execution", async () => {
  const f = await reviewDependencyFixture();
  try {
    const cycle = "REPAIR-CYCLE";
    const row = f.store.get("DOWN");
    f.store.updateStatus("DOWN", "failed", { ...row.details, review_reopen: { ...row.details.review_reopen, repair_cycle_id: cycle } });
    f.downstream.review_repair_cycle_id = cycle;
    const checkpoint = { status: "in_progress", phase: "review_repair", review_cycle_id: cycle,
      last_completed_turn: 127, review_findings: [{ failure: "Missing regression coverage" }] };
    const calls = [];
    const registry = { ...f.registry, assertReady: async () => ({ sprint: f.basis, plan: { content: { tickets: ["DOWN"], ticket_specs: [f.ticket] } } }) };
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: f.ticket }) },
      sprintRegistry: registry, ticketStatusStore: f.store, reconcileReviewDependencies: f.reconcile,
      checkpoints: { load: async () => checkpoint, loadReview: async () => f.input.reviewCheckpoint, clear: async () => assert.fail("Must retain checkpoint") },
      protocolStorage: { clearTask: async () => assert.fail("Must retain report") }, conversationStateStore: { clear: async () => assert.fail("Must retain conversation") },
      dispatchTask: async (input) => {
        assertDependencySubmission({ projectId: "P", ticket: input.ticket, payload: { execution_id: input.executionId,
          sprint_basis: input.sprintBasis, dependency_expectations: input.dependencyExpectations }, sprintRegistry: registry, ticketStatusStore: f.store });
        calls.push(input); return { status: "accepted" };
      } });
    const result = await dispatch({ projectId: "P", ticketId: "DOWN" });
    assert.equal(result.resumed_from_turn, 127);
    assert.equal(result.execution_id, "REPAIR");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].resume_from, checkpoint);
    assert.equal(calls[0].dependencyExpectations[0].execution_id, "NEW");
    assert.ok(f.store.get("DOWN").details.review_dependency_reconciliation);
  } finally { await f.close(); }
});

// Retained provider launch ownership and concurrent downstream transitions must never be overwritten by repair preflight.
test("repair reconciliation rejects a retained launch or stale downstream version", async () => {
  for (const scenario of ["launch", "version"]) {
    const f = await reviewDependencyFixture();
    try {
      if (scenario === "launch") {
        f.store.resumeReviewExecution("DOWN", { executionId: "REPAIR", basis: f.basis, expectedVersion: f.store.get("DOWN").version,
          dependencyExpectations: f.previous, validate: () => {} });
        f.store.claimExecutionLaunch("DOWN", { executionId: "REPAIR", basis: f.basis, requestId: "R", jobId: "J", supervisorId: "S", agentId: "A", validate: () => {} });
        f.input.current = f.store.get("DOWN");
      } else f.store.updateStatus("DOWN", "failed", { reason: "Concurrent stop" });
      const before = f.store.get("DOWN");
      await assert.rejects(f.reconcile(f.input), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
      assert.deepEqual(f.store.get("DOWN"), before);
    } finally { await f.close(); }
  }
});
