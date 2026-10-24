/** Covers mutable Coder retry context separately from execution ownership and
 * immutable review snapshots, including real SDK integration after a timed
 * retry so a stale preparation guard cannot silently return. */
import assert from "node:assert/strict";
import test from "node:test";
import { matchesTicketRetrySource, assertTicketRetrySource } from "../../src/modules/supervisor/ticket-retry-source.js";
import { coderProductionRecoveryFixture, BASIS, TICKET } from "../fixtures/coder-production-recovery-fixture.js";

const expected = { task_id: "T", project_id: "P", supervisor_id: "SUP-T", base_sha: "BASE", execution_root: "project-root",
  source_revision: "REV-1", manifest_sha: "MANIFEST-1", review_commit_sha: "COMMIT-1", state: "coding" };
const workspace = { root_only: true };

test("Coder accepts refreshed source fields but cannot change ticket, project, owner or baseline", () => {
  for (const field of ["source_revision", "manifest_sha", "review_commit_sha"]) {
    const current = { ...expected, [field]: "NEW" };
    assert.equal(matchesTicketRetrySource({ workspace, expected, current }), true);
    assert.equal(matchesTicketRetrySource({ workspace, expected, current, reviewResume: true }), false);
    assert.equal(matchesTicketRetrySource({ workspace: { root_only: false }, expected, current }), false);
  }
  for (const field of ["task_id", "project_id", "supervisor_id", "base_sha", "execution_root"]) {
    assert.equal(matchesTicketRetrySource({ workspace, expected, current: { ...expected, [field]: "OTHER" } }), false);
  }
  assert.equal(matchesTicketRetrySource({ workspace, expected, current: null }), false);
  assert.equal(matchesTicketRetrySource({ workspace, expected, current: { ...expected, state: "terminal" } }), false);
});

test("source refresh logs factual revision changes without mutating saved approval or context", () => {
  const current = { ...expected, source_revision: "REV-2", manifest_sha: "MANIFEST-2", review_commit_sha: null };
  const logs = [];
  assertTicketRetrySource({ workspace, expected, current, taskId: "T", projectLogger: (event) => logs.push(event) });
  assert.equal(expected.source_revision, "REV-1");
  assert.equal(current.source_revision, "REV-2");
  assert.equal(logs[0].event_name, "ticket.retry_source_refreshed");
  assert.deepEqual(logs[0].payload.changed_fields, ["source_revision", "manifest_sha", "review_commit_sha"]);
  assert.throws(() => assertTicketRetrySource({ workspace, expected, current, reviewResume: true }),
    { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
});

test("30-second operational retry keeps checkpoint 82 while dispatching refreshed shared-root context", async (t) => {
  const f = await coderProductionRecoveryFixture(); t.after(f.close);
  f.workspace.root_only = true;
  f.workspace.changeLedger.observe = f.workspace.changeLedger.snapshot;
  const checkpoint = { task_id: "TASK", last_completed_turn: 82, thread_id: "RETAINED", status: "in_progress" };
  await f.checkpoints.save(checkpoint);
  const result = await f.service.runTicket({ ticket: TICKET, task_id: "TASK", project_id: "P", request_id: "RETRY",
    payload: { execution_id: "EXEC", sprint_basis: BASIS, dependency_expectations: [], resume_from: checkpoint } });
  assert.equal(result.status, "recovery_pending");
  f.staleSource();
  f.advance(30_000);
  await f.restart().tick();
  assert.equal(f.invocations, 2);
  assert.equal((await f.checkpoints.load("TASK")).last_completed_turn, 82);
  assert.equal((await f.checkpoints.load("TASK")).thread_id, "RETAINED");
  assert.equal(f.statusStore.get().details.execution_id, "EXEC");
});
