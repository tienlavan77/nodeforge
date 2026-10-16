// Verifies operational review RUN retains approved execution identity and cannot bypass dependency or launch reconciliation gates.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

const BASIS = { project_id: "PROJECT-1", sprint_id: "SPRINT-1", plan_id: "PLAN-1", plan_revision: 1, plan_path: "workflows/plan.json", plan_sha256: "a".repeat(64), version: 7, status: "ready" };

// Models transactional status rows without requiring a platform SQLite binary for this focused authority test.
function resumeStatusFixture() {
  let row = { project_id: "PROJECT-1", ticket_id: "TICKET-1", status: "needs_human_review", version: 3, error: null,
    details_json: JSON.stringify({ execution_id: "RUN-ORIGINAL", execution_basis: BASIS, dependency_expectations: [] }) };
  const database = {
    all: (sql) => sql.startsWith("SELECT * FROM ticket_status WHERE") ? [structuredClone(row)] : [],
    run: (sql, values) => {
      if (!sql.startsWith("UPDATE ticket_status SET")) return { changes: 0 };
      const [status, version, error, details, updated, projectId, ticketId, previousStatus, previousVersion] = values;
      if (row.status !== previousStatus || row.version !== previousVersion || row.project_id !== projectId || row.ticket_id !== ticketId) return { changes: 0 };
      row = { ...row, status, version, error, details_json: details, updated_at: updated };
      return { changes: 1 };
    },
    transaction: (operation) => { const prior = structuredClone(row); try { return operation(); } catch (error) { row = prior; throw error; } }
  };
  const store = createTicketStatusStore({ database, projectId: "PROJECT-1" });
  return { store, setRow: (patch) => { row = { ...row, ...patch }; }, resume: (patch = {}) => store.resumeReviewExecution("TICKET-1", { executionId: "RUN-ORIGINAL", basis: BASIS, expectedVersion: 3, dependencyExpectations: [], validate: () => {}, ...patch }) };
}

// Keeps the same execution and source authority while explicitly resuming a parked operational review.
test("review resume keeps the original execution basis and increments only the status version", () => {
  const fixture = resumeStatusFixture();
  const result = fixture.resume();
  assert.equal(result.status, "running");
  assert.equal(result.version, 4);
  assert.equal(result.details.execution_id, "RUN-ORIGINAL");
  assert.deepEqual(result.details.execution_basis, BASIS);
});

// Refuses stale ownership, fresh dependency intent, unresolved provider launches, or reopening completed tickets.
test("review resume authority checks fail closed and preserve parked status", () => {
  for (const patch of [{ executionId: "RUN-REPLACEMENT" }, { expectedVersion: 2 }, { basis: { ...BASIS, version: 8 } }, { dependencyExpectations: [{ ticket_id: "NEW-DEPENDENCY" }] }]) {
    const fixture = resumeStatusFixture();
    assert.throws(() => fixture.resume(patch), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.equal(fixture.store.get("TICKET-1").status, "needs_human_review");
  }
  const fixture = resumeStatusFixture();
  fixture.setRow({ details_json: JSON.stringify({ execution_id: "RUN-ORIGINAL", execution_basis: BASIS, dependency_expectations: [], launch_claim: { request_id: "UNRECONCILED" } }) });
  assert.throws(() => fixture.resume(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  fixture.setRow({ status: "done" });
  assert.throws(() => fixture.resume(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
});

// Requires synchronous validation inside the transaction and rolls back when dependency authority is lost.
test("review resume validation cannot escape the authority transaction", () => {
  const fixture = resumeStatusFixture();
  assert.throws(() => fixture.resume({ validate: async () => {} }), { code: "STATUS_EXECUTION_INVALID" });
  assert.throws(() => fixture.resume({ validate: () => { throw new Error("Dependency changed"); } }), /Dependency changed/);
  assert.equal(fixture.store.get("TICKET-1").version, 3);
});

// Makes the owner RUN entry point use review recovery instead of assigning a replacement execution to the same verdict identity.
test("ticket RUN uses original execution for operational Reviewer resume", async () => {
  const fixture = resumeStatusFixture();
  const ticket = { id: "TICKET-1", project_id: "PROJECT-1", sprint_id: "SPRINT-1", title: "Review verified work", objective: "Verify result", dependencies: [], acceptance_criteria: ["Works"] };
  let dispatched;
  const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket }) },
    sprintRegistry: { get: () => BASIS, assertReady: async () => ({ sprint: BASIS, plan: { content: { tickets: [ticket.id], ticket_specs: [ticket] } } }) },
    ticketStatusStore: fixture.store, checkpoints: { load: async () => ({ status: "completed", agent_id: "coder-1", provider: "codex" }), loadReview: async () => ({ status: "failed" }) },
    protocolStorage: {}, conversationStateStore: {},
    dispatchTask: async (request) => { dispatched = request; return { status: "needs_human_review" }; } });
  await dispatch({ projectId: "PROJECT-1", ticketId: "TICKET-1" });
  assert.equal(dispatched.executionId, "RUN-ORIGINAL");
  assert(dispatched.review_resume);
  assert.equal(fixture.store.get("TICKET-1").details.execution_id, "RUN-ORIGINAL");
});
