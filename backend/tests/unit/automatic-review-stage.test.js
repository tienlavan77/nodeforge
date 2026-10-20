// Verifies visible review stages, default repair routing, and stale execution protection.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { assertAutomaticReviewResume, setAutomaticReviewStage } from "../../src/modules/supervisor/automatic-review-stage.js";
import { automaticReviewPolicy } from "../../src/modules/supervisor/automatic-review-identity.js";

// Models compare-and-swap status changes without replacing the original execution details.
function statusFixture() {
  let row = { status: "running", version: 1, details: { reason: "ticket_run" } };
  const stages = [];
  return { stages, get: () => structuredClone(row), updateStatus: (_id, status, details, expected) => {
    assert.equal(expected.expectedCurrentStatus, row.status);
    assert.equal(expected.expectedVersion, row.version);
    row = { status, details, version: row.version + 1 };
    stages.push(status);
  } };
}

test("unspecified policy reviews before completion and sends findings to Coder", async () => {
  const store = statusFixture();
  const fixture = automaticReviewFixture({ ticketStatusStore: store, review: async (_job, calls) => {
    assert.equal(store.get().status, "reviewing");
    assert.equal(fixture.integrations, 0);
    return calls === 1 ? { verdict: "request_changes", findings: [{ failure: "Missing session coverage", severity: "major" }] }
      : { verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed" }] };
  } });
  delete fixture.request.ticket.execution_policy.review_gate;
  const result = await fixture.complete(async ({ request, findings }) => {
    assert.equal(findings[0].failure, "Missing session coverage");
    setAutomaticReviewStage({ ...request, review_policy: { gate: "on" } }, store, "running");
    fixture.revise();
    return { request: { ...request, attempt: 2 }, result: { tool_events: [{ tool: "report_done", status: "success" }] } };
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(store.stages, ["reviewing", "running", "reviewing"]);
  assert.equal(fixture.integrations, 1);
  assert.equal(automaticReviewPolicy({}).gate, "on");
  assert.equal(automaticReviewPolicy({ execution_policy: { review_gate: "off" } }).gate, "off");
});

test("review cannot overwrite a terminal ticket or a foreign execution", () => {
  assert.throws(() => setAutomaticReviewStage({ task_id: "T", review_policy: { gate: "on" } }, { get: () => ({ status: "done" }) }, "reviewing"), { code: "REVIEW_STATUS_INVALID" });
  assert.throws(() => setAutomaticReviewStage({ task_id: "T", review_policy: { gate: "on" }, payload: { execution_id: "other" } }, { get: () => ({ status: "reviewing", details: { execution_id: "original" } }) }, "running"), { code: "EXECUTION_RECONCILIATION_CONFLICT" });
});

// Requires provider reconciliation before a second RUN can dispatch the same review execution.
test("review resume rejects an active matching provider and ignores a different execution", async () => {
  const queue = { list: async () => [{ automatic_review: true, task_id: "T", running_attempt: "OP-1", payload: { execution_id: "RUN-1" } }] };
  await assert.rejects(assertAutomaticReviewResume(queue, "T", "RUN-1"), { code: "REVIEW_ATTEMPT_ACTIVE" });
  await assertAutomaticReviewResume(queue, "T", "RUN-2");
});
