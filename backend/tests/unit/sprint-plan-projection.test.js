import assert from "node:assert/strict";
import test from "node:test";

import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";

test("projects current Sprint, selected Sprint, backlog, and planned status from Roadmap", () => {
  const store = createRoadmapStore();
  store.save(roadmap());
  const projection = createSprintPlanProjection({ roadmaps: store });

  assert.equal(projection.getCurrentSprint().id, "SPRINT-116-A");
  assert.equal(projection.getSprintById("SPRINT-116-B").objective, "Second governance milestone.");
  assert.deepEqual(projection.getSprintBacklog("SPRINT-116-A").map(({ id }) => id), ["NF-116-A", "NF-116-B"]);
  assert.deepEqual(projection.getSprintStatus("SPRINT-116-A"), {
    sprint_id: "SPRINT-116-A", status: "planned", ticket_count: 2, completed_ticket_count: 0, failed_ticket_count: 0
  });
  assert.deepEqual(projection.getSprintById("SPRINT-116-A"), projection.getSprintById("SPRINT-116-A"));
});

test("marks a mixed terminal sprint as completed with errors", () => {
  const store = createRoadmapStore();
  const value = roadmap();
  value.sprints[0].tickets[0].status = "done";
  value.sprints[0].tickets[1].status = "failed";
  store.save(value);
  const projection = createSprintPlanProjection({ roadmaps: store });

  assert.deepEqual(projection.getSprintStatus("SPRINT-116-A"), {
    sprint_id: "SPRINT-116-A", status: "completed_with_errors", ticket_count: 2, completed_ticket_count: 1, failed_ticket_count: 1
  });
});

test("keeps an all-done sprint as done", () => {
  const store = createRoadmapStore();
  const value = roadmap();
  value.sprints[0].tickets.forEach((ticket) => { ticket.status = "done"; });
  store.save(value);
  const projection = createSprintPlanProjection({ roadmaps: store });
  assert.equal(projection.getSprintStatus("SPRINT-116-A").status, "done");
});

test("selects a later sprint when it has an active ticket", () => {
  const store = createRoadmapStore();
  const value = roadmap();
  value.sprints[1].tickets[0].status = "pending";
  store.save(value);
  const projection = createSprintPlanProjection({ roadmaps: store });

  assert.equal(projection.getCurrentSprint().id, "SPRINT-116-B");
  assert.deepEqual(projection.getSprintBacklog("SPRINT-116-B").map(({ id }) => id), ["NF-116-C"]);
});

test("keeps the first sprint as current when no sprint has active work", () => {
  const store = createRoadmapStore();
  store.save(roadmap());
  const projection = createSprintPlanProjection({ roadmaps: store });
  assert.equal(projection.getCurrentSprint().id, "SPRINT-116-A");
});

test("does not mutate the canonical Roadmap or create projection state", () => {
  const store = createRoadmapStore();
  store.save(roadmap());
  const projection = createSprintPlanProjection({ roadmaps: store });
  const sprint = projection.getCurrentSprint();
  sprint.tickets[0].title = "mutated";

  assert.equal(store.getCurrent().sprints[0].tickets[0].title, "Ticket NF-116-A");
  assert.throws(() => projection.getSprintBacklog("SPRINT-missing"), /Unknown Sprint Plan/);
});

function roadmap() {
  return {
    id: "ROADMAP-116", project_id: "PROJECT-116", version: "1.0.0", created_at: "2026-08-20T10:00:00Z",
    sprints: [sprint("SPRINT-116-A", "First governance milestone.", ["NF-116-A", "NF-116-B"]), sprint("SPRINT-116-B", "Second governance milestone.", ["NF-116-C"])]
  };
}

function sprint(id, objective, ticketIds) {
  return {
    id, roadmap_id: "ROADMAP-116", project_id: "PROJECT-116", objective,
    tickets: ticketIds.map((ticketId) => ({
      id: ticketId, project_id: "PROJECT-116", roadmap_id: "ROADMAP-116", sprint_id: id,
      title: `Ticket ${ticketId}`, objective: "Implement governance.", acceptance_criteria: ["Tests pass"],
      provenance: { source: "sprint_plan", source_id: id, created_at: "2026-08-20T10:00:00Z" }
    })),
    exit_criteria: ["Tests pass"]
  };
}
