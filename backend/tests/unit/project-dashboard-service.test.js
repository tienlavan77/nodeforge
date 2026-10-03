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

test("dashboard reads persisted tickets and status when roadmap omits ticket rows", () => {
  const ticket = { project_id: "PROJECT-140", id: "TICKET-PERSISTED", title: "Persisted", roadmap_id: "ROADMAP-140", sprint_id: "SPRINT-140", status: "planned" };
  const service = createProjectDashboardService({
    roadmaps: { getCurrent: () => ({ id: "ROADMAP-140", project_id: "PROJECT-140", version: "1", sprints: [{ id: "SPRINT-140", objective: "Ship", tickets: [] }] }) },
    sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => ({ status: "planned" }), getSprintBacklog: () => [] },
    sprintRegistry: { list: () => [{ sprint_id: "SPRINT-140", project_id: "PROJECT-140", position: 0, status: "ready" }] },
    ticketFileStore: { listMetadata: () => [{ id: ticket.id, sprint_id: ticket.sprint_id, project_id: ticket.project_id }], getMetadata: () => ({ project_id: ticket.project_id }), readLatest: () => ticket },
    ticketStatusStore: { get: () => ({ project_id: "PROJECT-140", status: "running" }) },
    logReader: async () => ({ events: [{ payload: { to: "done" } }] })
  });
  const dashboard = service.getDashboard("PROJECT-140");
  assert.equal(dashboard.roadmap.sprints[0].status, "ready");
  assert.deepEqual(dashboard.roadmap.sprints[0].tasks.map(({ id, status }) => ({ id, status })), [{ id: ticket.id, status: "running" }]);
  assert.equal(service.getTicket("PROJECT-140", ticket.id).id, ticket.id);
});

test("dashboard rejects persisted tickets assigned to a different project or sprint", () => {
  const service = createProjectDashboardService({
    roadmaps: { getCurrent: () => undefined },
    sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => ({ status: "planned" }), getSprintBacklog: () => [] },
    ticketFileStore: { listMetadata: () => [{ id: "TICKET-X", project_id: "PROJECT-140", sprint_id: "SPRINT-140" }], readLatest: () => ({ id: "TICKET-X", project_id: "PROJECT-OTHER", sprint_id: "SPRINT-140" }) }
  });
  assert.throws(() => service.getDashboard("PROJECT-140"), { statusCode: 409 });
});

// Keeps historical registry entries from breaking the current project dashboard.
test("dashboard tolerates a registered sprint absent from the current roadmap", () => {
  const service = createProjectDashboardService({
    roadmaps: { getCurrent: () => ({ id: "ROADMAP-140", project_id: "PROJECT-140", version: "2", sprints: [] }) },
    sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => { throw new Error("unknown sprint"); }, getSprintBacklog: () => { throw new Error("unknown sprint"); } },
    sprintRegistry: { list: () => [{ sprint_id: "SPRINT-OLD", project_id: "PROJECT-140", position: 0, status: "done" }] }
  });
  assert.deepEqual(service.getDashboard("PROJECT-140").roadmap.sprints, [{ id: "SPRINT-OLD", objective: null, order: 1, status: "done", tasks: [] }]);
});
