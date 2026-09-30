import assert from "node:assert/strict";
import test from "node:test";

import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";

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
  const sprint = makeSprint();
  const service = createSprintOrchestrationService({
    sprintPlans: { getSprintById: () => structuredClone(sprint) },
    sprintPlanStore: { save: () => {}, getAllVersions: () => [] },
    agentGateway: { async *stream(args) { streams.push(args); yield { text: "UNUSED" }; } },
    publisher: { publish: (event) => { published.push(event); return event; } },
    agentRoles: ["sprint-leader"],
    sprintPlanLeader: {
      requestPlan: async (args) => {
        requests.push(args);
        return {
          id: "SPRINT-1",
          roadmap_id: "ROADMAP-1",
          project_id: "P1",
          objective: "Ship the API",
          tickets: [{ title: "Fix endpoint", objective: "Fix it.", acceptance_criteria: ["Works."], style: ["backend"], candidate_files: [{ path: "backend/a.js", role: "PATCH", symbol: "handleRequest", reason: "edit handleRequest" }] }],
          exit_criteria: ["Done"]
        };
      }
    }
  });
  const result = service.run({ projectId: "P1", sprintId: "SPRINT-1" });
  assert.equal(result.state, "RUNNING");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.length, 1);
  assert.equal(streams.length, 0);
  assert.match(requests[0].brief, /SPRINT-1/);
  const completed = published.filter((event) => event.type === "agent.completed");
  assert.equal(completed.length, 1);
  const savedPlan = JSON.parse(completed[0].payload.text);
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
    agentRoles: ["sprint-leader"],
    candidateResolver: { resolve: async (draft) => ({ ...draft, candidate_files: [{ path: "backend/b.js", role: "REFERENCE", reason: "retrieval:real" }], candidates_produced_by: "retrieval", candidates_produced_at: "2026-09-23T00:00:00Z" }) },
    sprintPlanLeader: {
      requestPlan: async () => ({
        id: "SPRINT-1",
        roadmap_id: "ROADMAP-1",
        project_id: "P1",
        objective: "Ship the API",
        tickets: [{ title: "Fix endpoint", objective: "Fix it.", acceptance_criteria: ["Works."], style: ["backend"] }],
        exit_criteria: ["Done"]
      })
    }
  });
  service.run({ projectId: "P1", sprintId: "SPRINT-1" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const completed = published.filter((event) => event.type === "agent.completed");
  assert.equal(completed.length, 1);
  const savedPlan = JSON.parse(completed[0].payload.text);
  assert.equal(savedPlan.tickets[0].candidate_files, undefined);
  assert.equal(savedPlan.tickets[0].candidates_produced_by, undefined);
});
