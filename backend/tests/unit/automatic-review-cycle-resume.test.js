// Preserves Owner-authorized repair review after operational resumes omit transient request metadata.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { bindAutomaticReviewCycle } from "../../src/modules/supervisor/automatic-review-identity.js";

// Records a Node-owned repair cycle while retaining the original ticket's historical review policy.
async function bindRepair(fixture, cycle = "REPAIR-CYCLE") {
  const context = await fixture.workspace.executionContexts.load(fixture.request.task_id);
  await fixture.workspace.executionContexts.update(fixture.request.task_id, context.version, { review_repair_cycle_id: cycle });
}

test("missing resume metadata cannot mix an active repair review with historical soft-review jobs", async () => {
  const f = automaticReviewFixture({ gate: "off" });
  const historical = await f.prepare();
  assert.equal(historical.review_policy.gate, "off");
  await bindRepair(f);
  delete f.request.payload.review_cycle_id;
  const result = await f.complete();
  assert.equal(result.status, "completed"); assert.equal(f.calls, 1); assert.equal(f.integrations, 1);
  const jobs = await f.queueStore.list("agent.request");
  const repair = jobs.find((entry) => entry.payload.review_cycle_id === "REPAIR-CYCLE");
  assert.equal(repair.review_policy.gate, "on"); assert.equal(repair.source_request.payload.review_cycle_id, "REPAIR-CYCLE");
  assert.equal(jobs.find((entry) => entry.id === historical.id).review_policy.gate, "off");
  assert(f.order.indexOf("review") < f.order.indexOf("integrate"));
});

test("prepare also restores the canonical cycle independently of the completion caller and across restart", async () => {
  const f = automaticReviewFixture({ gate: "off" });
  await f.prepare(); await bindRepair(f);
  const prepared = await f.restart().prepare({ request: f.request, artifact: f.artifact, workspace: f.workspace });
  assert.equal(prepared.review_policy.gate, "on"); assert.equal(prepared.payload.review_cycle_id, "REPAIR-CYCLE");
  assert.equal(f.calls, 0); assert.equal(f.integrations, 0);
});

test("a conflicting cycle cannot disable repair review or consume another cycle's approval", async () => {
  const f = automaticReviewFixture({ gate: "off" }); await bindRepair(f);
  f.request.payload.review_cycle_id = "OTHER-CYCLE";
  await assert.rejects(f.prepare(), { code: "REVIEW_POLICY_CONFLICT" });
  await assert.rejects(f.complete(), { code: "REVIEW_POLICY_CONFLICT" });
  assert.equal(f.calls, 0); assert.equal(f.integrations, 0);
  assert.equal(bindAutomaticReviewCycle(f.request, {}).payload.review_cycle_id, "OTHER-CYCLE");
});
