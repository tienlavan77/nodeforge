// Verifies serious findings remain repairable while source-bound scope and independent acceptance checks stay enforced.
// Legacy severity-based parking is reconciled once without replaying Reviewer, changing finding severity or losing audits.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { reconcileReviewRepairAuthority, reviewRepairScopeConflict } from "../../src/modules/supervisor/review/review-repair-authority.js";

// Exercises the inline production completion path through Coder repair, fresh verification and independent re-review.
test("an in-scope blocker returns to Coder and cannot complete until Reviewer approves the repaired revision", async () => {
  const f = automaticReviewFixture({ review: async (_job, calls) => calls === 1
    ? { verdict: "request_changes", findings: [{ severity: "blocker", failure: "Fix the implementation", files: ["backend/src/sample.js"] }] }
    : { verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed" }] } });
  let repairs = 0;
  const result = await f.complete(async ({ request, findings }) => {
    repairs++;
    assert.equal(findings[0].severity, "blocker");
    assert.equal(f.integrations, 0);
    assert.equal(f.events.some((event) => event.type === "task.completed"), false);
    f.revise();
    return { request: { ...request, attempt: 2 }, result: { summary: "Repaired", tool_events: [{ name: "report_done", status: "success" }] } };
  });
  assert.equal(result.status, "completed");
  assert.equal(repairs, 1);
  assert.equal(f.calls, 2);
  assert.equal(f.integrations, 1);
  assert.equal(f.events.some((event) => ["task.needs_human_review", "review.owner_decision_required"].includes(event.type)), false);
});

// Real edit-scope changes still require authority, including when a finding has a less severe label.
for (const severity of ["major", "blocker"]) {
  test(`${severity} findings outside the approved baseline retain the scope gate`, async () => {
    const f = automaticReviewFixture({ review: async () => ({ verdict: "request_changes",
      findings: [{ severity, failure: "Change another component", files: ["backend/src/outside.js"] }] }) });
    const context = await f.workspace.executionContexts.load();
    f.workspace.executionContexts.load = async () => ({ ...context, approved_baseline: { file_checksums: { "backend/src/sample.js": "approved" } } });
    const outcome = await f.service.process(await f.prepare());
    assert.equal(outcome.payload.owner_decision_reason, "review_scope_conflict");
    assert.equal(f.integrations, 0);
    assert(f.events.some((event) => event.type === "review.owner_decision_required"));
  });
}

// Reuses persisted request_changes after restart and records a distinct routing event without another provider call.
test("legacy review_blocker parking reconciles once and preserves findings plus historical receipts", async () => {
  const f = automaticReviewFixture({ review: async () => ({ verdict: "request_changes",
    findings: [{ severity: "blocker", failure: "Repair this defect", files: ["backend/src/sample.js"] }] }) });
  const job = await f.prepare();
  await f.service.process(job);
  const [saved] = await f.queueStore.list("agent.request");
  const parking = { reason_code: "review_blocker", event_id: "HISTORICAL-PARK" };
  const legacy = { ...saved, parking_outcome: parking, parking_outcomes: [parking],
    review_result: { ...saved.review_result, payload: { ...saved.review_result.payload, owner_decision_reason: "review_blocker" } } };
  await f.queueStore.save("agent.request", legacy);
  await f.restart().recover();
  const result = await f.service.process(legacy);
  assert.equal(result.payload.owner_decision_reason, undefined);
  assert.deepEqual(result.payload.findings, saved.review_result.payload.findings);
  assert.equal(f.calls, 1);
  assert.equal(f.events.some((event) => event.type === "task.needs_human_review"), false);
  const [next] = await f.queueStore.list("agent.request");
  assert.equal(next.parking_outcome, null);
  assert.deepEqual(next.parking_outcomes, [parking]);
  assert.deepEqual(next.outcomes, saved.outcomes);
  assert.equal(next.repair_authority_reconciliation.previous_reason, "review_blocker");
  assert.equal(next.repair_authority_reconciliation.previous_event_id, saved.event_id);
  assert.notEqual(next.event_id, saved.event_id);
  await f.service.process(next);
  assert.equal((await f.queueStore.list("agent.request"))[0].event_id, next.event_id);
  assert.equal(f.calls, 1);
});

// Preserves other Owner decisions and rejects mismatched cached evidence rather than clearing it as a severity-only gate.
test("authority reconciliation preserves real gates and refuses stale verdict bindings", async () => {
  const f = automaticReviewFixture({ review: async () => ({ verdict: "request_changes", findings: [{ severity: "blocker", failure: "Repair" }] }) });
  await f.service.process(await f.prepare());
  const [job] = await f.queueStore.list("agent.request");
  const scoped = { ...job, review_result: { ...job.review_result, payload: { ...job.review_result.payload, owner_decision_reason: "review_scope_conflict" } } };
  assert.equal(reconcileReviewRepairAuthority(scoped), scoped);
  const stale = { ...job, payload: { ...job.payload, commit: "replaced" },
    review_result: { ...job.review_result, payload: { ...job.review_result.payload, owner_decision_reason: "review_blocker" } } };
  assert.throws(() => reconcileReviewRepairAuthority(stale), { code: "EXECUTION_RECONCILIATION_CONFLICT" });
  assert.equal(reviewRepairScopeConflict([{ finding: { severity: "blocker", files: ["outside.js"] } }],
    { approved_baseline: { file_checksums: { "inside.js": "approved" } } }), true);
});
