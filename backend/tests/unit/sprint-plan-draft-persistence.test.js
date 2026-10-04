// Verifies immutable Sprint draft provenance persists independently from optional registry registration.
import assert from "node:assert/strict";
import test from "node:test";
import { createSprintPlanDraftPersistence } from "../../src/modules/governance/sprint-plan-draft-persistence.js";

const sprint = {
  id: "SPRINT-O6",
  project_id: "PROJECT-O6",
  objective: "Preserve plan provenance",
  tickets: [{ id: "TICKET-O6", title: "Persist provenance", objective: "Persist immutable provenance", implementation_type: ["backend"], file_budget: 4, acceptance_criteria: ["Immutable record"] }],
  human_plan: {
    outcome: "An immutable plan record",
    in_scope: "Plan persistence",
    out_of_scope: "Execution",
    approach: "Create a first revision",
    components: ["Governance"],
    risks: [],
    assumptions: [],
    open_questions: [],
    evidence_refs: ["SUMMARY-O6"],
    acceptance_criteria: ["Immutable record"]
  }
};

// Provides an in-memory immutable plan index for persistence boundary tests.
function planStore() {
  const revisions = [];
  return {
    revisions,
    list: () => revisions.map(({ plan_id, revision }) => ({ plan_id, revision })),
    createRevision: async (input) => {
      const revision = { ...input, plan_id: input.planId, revision: 1, sha256: "a".repeat(64), status: "awaiting_human_approval" };
      revisions.push(revision);
      return revision;
    },
    getRevision: async ({ planId, revision }) => revisions.find((item) => item.plan_id === planId && item.revision === revision)
  };
}

test("persists an awaiting approval revision and registers it when a registry is available", async () => {
  const plans = planStore();
  const calls = [];
  const registry = {
    get: () => null,
    list: () => [],
    register: async (input) => { calls.push(input); }
  };
  const draft = createSprintPlanDraftPersistence({ projectId: "PROJECT-O6", planStore: plans, sprintRegistry: registry });
  const result = await draft(sprint);

  assert.equal(result.status, "awaiting_human_approval");
  assert.equal(result.sha256, "a".repeat(64));
  assert.equal(plans.revisions[0].expectedRevision, 0);
  assert.equal(plans.revisions[0].proposalId, null);
  assert.deepEqual(calls, [{ sprintId: "SPRINT-O6", position: 0, planId: "PLAN-SPRINT-O6", revision: 1, status: undefined }]);
});

test("persists an awaiting approval revision without claiming registration when the registry is unavailable", async () => {
  const plans = planStore();
  const draft = createSprintPlanDraftPersistence({ projectId: "PROJECT-O6", planStore: plans });
  const result = await draft(sprint);

  assert.equal(result.status, "awaiting_human_approval");
  assert.equal(result.plan_id, "PLAN-SPRINT-O6");
  assert.equal(plans.revisions.length, 1);
});
