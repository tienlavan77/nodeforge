import assert from "node:assert/strict";
import test from "node:test";

import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";

test("projects roadmap, current sprint, backlog, ticket progress, and provenance read-only", () => {
  const ticket = { project_id: "PROJECT-140", id: "TICKET-140", title: "Dashboard", priority: "high", roadmap_id: "ROADMAP-140", sprint_id: "SPRINT-140" };
  const sprint = { id: "SPRINT-140", objective: "Dashboard objective", roadmap_id: "ROADMAP-140", tickets: [ticket] };
  const roadmap = { id: "ROADMAP-140", project_id: "PROJECT-140", version: "2.0.0", sprints: [sprint] };
  const service = createProjectDashboardService({
    roadmaps: { getCurrent: () => roadmap },
    sprintPlans: { getCurrentSprint: () => sprint, getSprintStatus: () => ({ sprint_id: sprint.id, status: "planned", ticket_count: 1, completed_ticket_count: 0 }), getSprintBacklog: () => [ticket] },
    provenance: { validateProvenance: () => ({ architecture_decisions: [{ id: "DECISION-140" }], roadmap, sprint, ticket }) }
  });
  const dashboard = service.getDashboard("PROJECT-140");
  assert.equal(dashboard.roadmap.version, "2.0.0");
  assert.equal(dashboard.roadmap.sprints[0].objective, "Dashboard objective");
  assert.equal(dashboard.roadmap.sprints[0].tasks[0].status, "planned");
  assert.equal(dashboard.roadmap.sprints[0].tasks[0].priority, "high");
  dashboard.roadmap.sprints[0].tasks[0].title = "mutated";
  assert.equal(service.getDashboard("PROJECT-140").roadmap.sprints[0].tasks[0].title, "Dashboard");
});

test("returns a deterministic empty state for a project without a roadmap", () => {
  const service = createProjectDashboardService({ roadmaps: { getCurrent: () => undefined }, sprintPlans: { getCurrentSprint: () => undefined, getSprintStatus: () => ({}), getSprintBacklog: () => [] } });
  assert.deepEqual(service.getDashboard("PROJECT-140"), { project_id: "PROJECT-140", roadmap: null });
});
