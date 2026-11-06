// Verifies the public Forge plan CRUD routes while preserving revision-based plan semantics.
import test from "node:test";
import assert from "node:assert/strict";
import { routePlan } from "../../src/transport/http/forge-v1-plan-routes.js";

// Supplies the shared project identity required to exercise plan routes without allowing cross-project access.
function context(planStore) {
  return { projectId: "PROJECT-A", expectedProjectId: "PROJECT-A", planStore };
}

test("plan PUT and PATCH create immutable revisions through the CRUD endpoint", async () => {
  const calls = [];
  const planStore = {
    createRevision: async (input) => { calls.push(input); return { plan_id: input.planId, revision: input.expectedRevision + 1 }; }
  };
  const put = await routePlan({ ...context(planStore), method: "PUT", parts: ["plans", "PLAN-A"], body: { content: { title: "updated" }, expected_revision: 2 } });
  const patch = await routePlan({ ...context(planStore), method: "PATCH", parts: ["plans", "PLAN-A"], body: { content: { title: "patched" }, expected_revision: 3 } });
  assert.equal(put.status, 200);
  assert.equal(patch.status, 200);
  assert.deepEqual(calls.map(({ planId, content, expectedRevision }) => ({ planId, content, expectedRevision })), [
    { planId: "PLAN-A", content: { title: "updated" }, expectedRevision: 2 },
    { planId: "PLAN-A", content: { title: "patched" }, expectedRevision: 3 }
  ]);
});

test("plan DELETE passes the query concurrency token to the store", async () => {
  let input;
  const planStore = { deletePlan: async (value) => { input = value; return { plan_id: value.planId, deleted: true }; } };
  const result = await routePlan({ ...context(planStore), method: "DELETE", parts: ["plans", "PLAN-A"], body: {}, url: new URL("https://forge.test/forge/v1/plans/PLAN-A?expected_revision=4") });
  assert.equal(result.status, 200);
  assert.deepEqual(input, { planId: "PLAN-A", expectedRevision: 4 });
});

test("plan CRUD refuses a cross-project context before calling the store", async () => {
  let called = false;
  const planStore = { deletePlan: async () => { called = true; } };
  await assert.rejects(routePlan({ projectId: "PROJECT-B", expectedProjectId: "PROJECT-A", planStore, method: "DELETE", parts: ["plans", "PLAN-A"], body: {}, url: new URL("https://forge.test/?expected_revision=1") }), { code: "PROJECT_CONTEXT_CONFLICT" });
  assert.equal(called, false);
});
