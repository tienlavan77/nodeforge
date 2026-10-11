// Verifies Coding handoff authentication and exact approval identity before any Sprint Leader side effect.
import assert from "node:assert/strict";
import test from "node:test";
import { routePlan } from "../../src/transport/http/forge-v1-plan-routes.js";

// Provides an approved artifact and tracks decision, handoff and readiness boundaries.
function fixture() {
  const counts = { handoff: 0, ready: 0, decisions: 0 };
  const plan = { plan_id: "PLAN-A", revision: 2, sha256: "a".repeat(64), project_id: "PROJECT-A", format: "markdown", conversation_id: "ARCHIVE-CONVERSATION", decision: { approver_id: "OWNER" } };
  const store = { list: () => [plan], assertApproved: async ({ revision, sha256 }) => { assert.equal(revision, plan.revision); assert.equal(sha256, plan.sha256); return plan; }, decide: async () => { counts.decisions += 1; return {}; } };
  const context = { method: "POST", parts: ["plans", plan.plan_id, "2", "handoff"], projectId: "PROJECT-A", expectedProjectId: "PROJECT-A", body: { project_id: "PROJECT-A", sha256: plan.sha256 }, headers: { authorization: "Bearer valid" },
    planOwnerAuth: { verify: (headers) => { if (headers.authorization !== "Bearer valid") throw Object.assign(new Error("unauthorized"), { code: "PLAN_OWNER_UNAUTHORIZED" }); return "OWNER"; } }, planStore: { list: () => [] }, markdownPlanStore: store,
    sprintRegistry: { get: () => ({ status: "planned", version: 3 }), setStatus: async ({ expectedVersion }) => { assert.equal(expectedVersion, 3); counts.ready += 1; return { status: "ready" }; } },
    handoffApprovedPlan: async ({ plan: artifact, conversationId }) => { assert.equal(artifact, plan); assert.equal(conversationId, "ARCHIVE-CONVERSATION"); counts.handoff += 1; return { status: "handed_to_sprint_leader", sprint_id: "SPRINT-A" }; } };
  return { context, counts, plan, store };
}

test("authenticated Coding action uses persisted provenance and does not create a second decision or RUN", async () => {
  const { context, counts } = fixture();
  const result = await routePlan(context);
  assert.equal(result.body.sprint_status, "ready");
  assert.equal(result.body.run_started, false);
  assert.equal(result.body.coder_dispatched, false);
  assert.deepEqual(counts, { handoff: 1, ready: 1, decisions: 0 });
});

test("wrong owner, token, project, revision or hash cannot handoff", async () => {
  for (const mutate of [
    (c) => { c.headers = {}; }, (c) => { c.projectId = "PROJECT-B"; },
    (c) => { c.parts = ["plans", "PLAN-A", "1", "handoff"]; }, (c) => { c.body.sha256 = "b".repeat(64); },
    (c) => { c.markdownPlanStore.assertApproved = async () => ({ ...c.markdownPlanStore.list()[0], decision: { approver_id: "OTHER" } }); },
    (c) => { c.body.actor_role = "project_owner"; }, (c) => { c.body.sha256 = null; }
  ]) {
    const { context, counts } = fixture(); mutate(context);
    await assert.rejects(routePlan(context));
    assert.deepEqual(counts, { handoff: 0, ready: 0, decisions: 0 });
  }
});

test("source-integrity failure is preserved before provider handoff", async () => {
  const { context, counts } = fixture();
  context.markdownPlanStore.assertApproved = async () => { throw Object.assign(new Error("source mismatch"), { code: "PLAN_SOURCE_MISMATCH" }); };
  await assert.rejects(routePlan(context), { code: "PLAN_SOURCE_MISMATCH" });
  assert.equal(counts.handoff, 0);
});

test("handoff-in-progress does not claim Sprint readiness", async () => {
  const { context, counts } = fixture();
  context.handoffApprovedPlan = async () => ({ status: "handoff_in_progress" });
  const result = await routePlan(context);
  assert.equal(result.body.status, "handoff_in_progress");
  assert.equal(result.body.sprint_status, undefined);
  assert.equal(counts.ready, 0);
});

test("existing non-approved decisions do not invoke the handoff API", async () => {
  const { context, counts } = fixture();
  context.parts[3] = "decisions";
  for (const decision of ["rejected", "changes_requested"]) { context.body.decision = decision; await routePlan(context); }
  assert.equal(counts.decisions, 2);
  assert.equal(counts.handoff, 0);
});
