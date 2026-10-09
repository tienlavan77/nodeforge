import assert from "node:assert/strict";
import test from "node:test";

import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";

const humanPlan = { outcome: "Working API", in_scope: "Endpoint", out_of_scope: "Other services", approach: "Update endpoint", components: ["backend API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Sprint brief"], acceptance_criteria: ["Done"] };

// Covers SDK sprint planning without source candidates or the legacy stream.
function makeSprint() {
  return {
    id: "SPRINT-1",
    roadmap_id: "ROADMAP-1",
    project_id: "P1",
    objective: "Ship the API",
    tickets: [],
    exit_criteria: ["Done"]
  };
}

test("sdk sprint leader plan discards supplied candidates without legacy stream", async () => {
  const published = [];
  const streams = [];
  const requests = [];
  const drafts = [];
  const sprint = makeSprint();
  const service = createSprintOrchestrationService({
    sprintRegistry: { getDetail: async () => structuredClone(sprint), get: () => drafts.length ? { plan_id: "PLAN-SPRINT-1", plan_revision: 1, plan_sha256: "review-checksum", plan_path: "draft.json" } : null },
    sprintPlans: { getSprintById: () => { throw new Error("Registry-owned draft must not read Roadmap"); } },
    sprintPlanStore: { save: () => { throw new Error("Registry-owned draft must not write Roadmap"); } },
    agentGateway: { async *stream(args) { streams.push(args); yield { text: "UNUSED" }; } },
    publisher: { publish: (event) => { published.push(event); return event; } },
    draftPlan: async (plan) => { drafts.push(plan); return { plan_id: `PLAN-${plan.id}`, revision: 1, sha256: "review-checksum", file_path: "draft.json" }; },
    agentRoles: ["sprint-leader"],
    sprintPlanLeader: {
      requestPlan: async (args) => {
        requests.push(args);
        return {
          id: "SPRINT-1",
          roadmap_id: "ROADMAP-1",
          project_id: "P1",
          objective: "Ship the API",
          human_plan: humanPlan,
          tickets: [{ id: "TICKET-FIX-ENDPOINT", title: "Fix endpoint", objective: "Fix it.", acceptance_criteria: ["Works."], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/sprint-orchestration-sdk.test.js" }], implementation_type: ["backend"], file_budget: 4, candidate_files: [{ path: "backend/a.js", role: "PATCH", symbol: "handleRequest", reason: "edit handleRequest" }] }],
          exit_criteria: ["Done"]
        };
      }
    }
  });
  const result = await service.run({ projectId: "P1", sprintId: "SPRINT-1" });
  assert.equal(result.state, "RUNNING");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.length, 1);
  assert.equal(streams.length, 0);
  assert.match(requests[0].brief, /SPRINT-1/);
  const completed = published.filter((event) => event.type === "agent.completed");
  assert.equal(completed.length, 1);
  assert.equal(drafts.length, 1);
  assert.equal(published.find((event) => event.type === "governance.sprint_plan.created").payload.status, "awaiting_human_approval");
  assert.equal(published.filter((event) => event.type === "governance.sprint_plan.provenance_pending").length, 1);
  const savedPlan = JSON.parse(completed[0].payload.text);
  assert.deepEqual(savedPlan.tickets[0].implementation_type, ["backend"]);
  assert.equal(savedPlan.tickets[0].style, undefined);
  assert.equal(savedPlan.tickets[0].candidate_files, undefined);
  assert.equal(savedPlan.tickets[0].candidates_produced_by, undefined);
});

test("sdk plan ticket without candidates stays without candidates", async () => {
  const published = [];
  const sprint = makeSprint();
  const service = createSprintOrchestrationService({
    sprintPlans: { getSprintById: () => structuredClone(sprint) },
    sprintPlanStore: { save: () => {}, getAllVersions: () => [] },
    agentGateway: { async *stream() { yield { text: "UNUSED" }; } },
    publisher: { publish: (event) => { published.push(event); return event; } },
    draftPlan: async (plan) => ({ plan_id: `PLAN-${plan.id}`, revision: 1, sha256: "review-checksum" }),
    agentRoles: ["sprint-leader"],
    candidateResolver: { resolve: async (draft) => ({ ...draft, candidate_files: [{ path: "backend/b.js", role: "REFERENCE", reason: "retrieval:real" }], candidates_produced_by: "retrieval", candidates_produced_at: "2026-09-23T00:00:00Z" }) },
    sprintPlanLeader: {
      requestPlan: async () => ({
        id: "SPRINT-1",
        roadmap_id: "ROADMAP-1",
        project_id: "P1",
        objective: "Ship the API",
        human_plan: humanPlan,
        tickets: [{ id: "TICKET-FIX-ENDPOINT", title: "Fix endpoint", objective: "Fix it.", acceptance_criteria: ["Works."], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/sprint-orchestration-sdk.test.js" }], implementation_type: ["backend"], file_budget: 4 }],
        exit_criteria: ["Done"]
      })
    }
  });
  await service.run({ projectId: "P1", sprintId: "SPRINT-1" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const completed = published.filter((event) => event.type === "agent.completed");
  assert.equal(completed.length, 1);
  const savedPlan = JSON.parse(completed[0].payload.text);
  assert.equal(savedPlan.tickets[0].candidate_files, undefined);
  assert.equal(savedPlan.tickets[0].candidates_produced_by, undefined);
});

// Removes legacy file hints even when an approved handoff still contains them.
test("approved Sprint handoff does not persist candidate references", async () => {
  let saved;
  const plan = { ...makeSprint(), human_plan: humanPlan, tickets: [{ id: "TICKET-FIX-ENDPOINT", title: "Fix endpoint", objective: "Fix it.", acceptance_criteria: ["Works."], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/sprint-orchestration-sdk.test.js" }], implementation_type: ["backend"], file_budget: 4, candidate_files: [{ path: "backend/src/api.js", role: "REFERENCE", reason: "Observed with Forge search" }], candidates_produced_by: "sprint_leader", candidates_produced_at: "2026-10-03T00:00:00Z" }] };
  const service = createSprintOrchestrationService({ agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-CUSTOM" }) }, sprintPlans: { getSprintById: () => null }, sprintPlanStore: { save: (value) => { saved = value; }, getCurrent: () => null }, agentGateway: { async *stream() {} }, publisher: { publish: () => {} }, draftPlan: async () => ({ plan_id: "PLAN-1", revision: 1, sha256: "digest" }) });
  const text = `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
  assert.equal((await service.ingestAgentCompletion({ agentId: "sprint-leader", message: { project_id: "P1" }, text })).ingested, false);
  assert.equal(saved, undefined);
  assert.equal((await service.ingestAgentCompletion({ agentId: "LEADER-CUSTOM", message: { project_id: "P1", approved_parent_plan_key: "PLAN-PARENT-R1-digest" }, text })).ingested, true);
  assert.equal(saved.sprints[0].tickets[0].candidate_files, undefined);
  assert.equal(saved.sprints[0].tickets[0].candidates_produced_by, undefined);
  assert.equal(saved.sprints[0].tickets[0].candidates_produced_at, undefined);
});
