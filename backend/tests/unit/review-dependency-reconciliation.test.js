// Ensures stale dependency recovery is confined to proven parked repairs and preserves exact normal launch fences.
import assert from "node:assert/strict";
import test from "node:test";
import { reviewDependencyFixture } from "../fixtures/review-dependency-fixture.js";
import { assertDependencySubmission } from "../../src/modules/supervisor/ticket/ticket-dependency-expectations.js";
import { createReviewDependencyReconciliation } from "../../src/modules/supervisor/review/review-dependency-reconciliation.js";

// Reconciles exactly once while retaining Coder progress and the downstream execution/plan identity.
test("review repair adopts a verified same-plan completion and persists previous dependency identity", async () => {
  const f = await reviewDependencyFixture();
  try {
    const checkpoint = structuredClone(f.input.checkpoint);
    const result = await f.reconcile(f.input);
    assert.equal(result.status, "reviewing"); assert.equal(result.details.execution_id, "REPAIR");
    assert.deepEqual(result.details.dependency_expectations, f.dependencies);
    const receipt = JSON.parse(await f.files.readFile({ path: result.details.review_dependency_reconciliation.path }));
    assert.equal(receipt.previous[0].execution_id, "OLD"); assert.equal(receipt.dependencies[0].execution_id, "NEW");
    assert.equal(receipt.replacements[0].artifact_id, "ARTIFACT-UP");
    assert.deepEqual(f.input.checkpoint, checkpoint);
    assert.equal((await f.reconcile({ ...f.input, current: result })).version, result.version);
    assert.equal(f.logs.length, 1);
    f.store.resumeReviewExecution("DOWN", { executionId: "REPAIR", basis: f.basis, expectedVersion: result.version, dependencyExpectations: f.dependencies, validate: () => {} });
    assert.doesNotThrow(() => assertDependencySubmission({ projectId: "P", ticket: f.ticket, payload: { execution_id: "REPAIR", sprint_basis: f.basis, dependency_expectations: f.dependencies }, sprintRegistry: f.registry, ticketStatusStore: f.store }));
    assert.throws(() => assertDependencySubmission({ projectId: "P", ticket: f.ticket, payload: { execution_id: "REPAIR", sprint_basis: f.basis, dependency_expectations: f.previous }, sprintRegistry: f.registry, ticketStatusStore: f.store }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  } finally { await f.close(); }
});

// Repair-only reconciliation must not admit incomplete upstream work or a different immutable dependency plan.
test("changed project/plan/scope, incomplete evidence and active executions cannot rebind dependencies", async () => {
  for (const scenario of ["plan", "project", "scope", "source", "failed-artifact", "running", "upstream-running"]) {
    const f = await reviewDependencyFixture();
    try {
      if (scenario === "plan") f.input.dependencyExpectations[0].execution_basis.plan_revision = 2;
      if (scenario === "project") f.input.projectId = "OTHER";
      if (scenario === "scope") f.input.dependencyExpectations = [];
      if (scenario === "source") f.downstream.review_commit_sha = "other";
      if (scenario === "failed-artifact") await f.files.atomicWrite({ path: f.artifactPath, content: JSON.stringify({ ...f.artifact, status: "failed" }), replace: true });
      if (scenario === "running") f.input.current = f.store.updateStatus("DOWN", "running");
      if (scenario === "upstream-running") f.store.beginExecution("UP", { executionId: "THIRD", basis: f.basis, expectedVersion: f.store.get("UP").version, fresh: true, dependencyExpectations: [] });
      const before = f.store.get("DOWN");
      await assert.rejects(f.reconcile(f.input), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
      assert.deepEqual(f.store.get("DOWN"), before);
    } finally { await f.close(); }
  }
});

// A crash after receipt publication must be resumable; dependency movement during IO is still rejected transactionally.
test("restart reuses a prepared receipt and rejects a concurrently replaced upstream completion", async () => {
  const f = await reviewDependencyFixture();
  try {
    let crashed = false;
    const crash = createReviewDependencyReconciliation({ ...f.options, ticketStatusStore: { ...f.store, reconcileReviewDependencies: () => { crashed = true; throw new Error("Simulated crash after receipt"); } } });
    await assert.rejects(crash(f.input), /Simulated crash/); assert(crashed);
    assert.equal(f.store.get("DOWN").details.dependency_expectations[0].execution_id, "OLD");
    const restarted = createReviewDependencyReconciliation(f.options);
    assert.equal((await restarted(f.input)).details.dependency_expectations[0].execution_id, "NEW");
  } finally { await f.close(); }
  const g = await reviewDependencyFixture();
  try {
    const raced = createReviewDependencyReconciliation({ ...g.options, ticketStatusStore: { ...g.store, reconcileReviewDependencies: (id, options) => {
      g.store.beginExecution("UP", { executionId: "THIRD", basis: g.basis, expectedVersion: g.store.get("UP").version, fresh: true, dependencyExpectations: [] });
      return g.store.reconcileReviewDependencies(id, options);
    } } });
    await assert.rejects(raced(g.input), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.equal(g.store.get("DOWN").details.dependency_expectations[0].execution_id, "OLD");
  } finally { await g.close(); }
});
