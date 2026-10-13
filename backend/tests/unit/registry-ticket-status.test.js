// Verifies ticket View, graph and dashboard show the same execution status instead of plan defaults.
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

// Builds immutable planned content and a independently changing runtime status for projection regressions.
function fixture() {
  const basis = { project_id: "PROJECT-1", sprint_id: "SPRINT-1", plan_id: "PLAN-1", plan_revision: 1, plan_path: ".forge/runtime/plans/1.json", plan_sha256: "a".repeat(64), version: 2 };
  const ticket = { id: "TICKET-1", project_id: basis.project_id, sprint_id: basis.sprint_id, title: "Approved ticket", objective: "Keep approved scope", acceptance_criteria: ["Approved behavior"], status: "pending" };
  const state = { persisted: { project_id: basis.project_id, ticket_id: ticket.id, status: "running", details: { execution_id: "RUN-1", execution_basis: { ...basis, version: 1 } } } };
  const service = createProjectDashboardService({
    roadmaps: { getCurrent: () => null },
    sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => ({}), getSprintBacklog: () => [] },
    sprintRegistry: {
      getByTicket: async () => basis,
      get: () => basis,
      list: () => [basis],
      listDetails: async () => [],
      getDetail: async () => ({ ...basis, id: basis.sprint_id, ticket_ids: [ticket.id], tickets: [ticket] })
    },
    ticketStatusStore: { get: () => state.persisted },
    relevantTreeSelector: { select: () => ({ files: [] }) }
  });
  return { basis, ticket, state, service };
}

// Reads all owner-facing projections to ensure none falls back to the immutable ticket status.
async function assertProjections(fixture, status, progress) {
  const { service, ticket } = fixture;
  const detail = await service.getTicket(ticket.project_id, ticket.id);
  const graph = await service.getTicketGraph(ticket.project_id, ticket.id);
  const dashboard = await service.getDashboard(ticket.project_id);
  for (const projection of [detail, graph.ticket, dashboard.roadmap.sprints[0].tasks[0]]) {
    assert.equal(projection.status, status);
    assert.equal(projection.progress, progress);
    assert.equal(projection.title, ticket.title);
  }
  assert.equal(ticket.status, "pending");
  assert.deepEqual(detail.acceptance_criteria, ticket.acceptance_criteria);
}

test("View and graph track running, reviewing and terminal runtime status with dashboard", async () => {
  const current = fixture();
  for (const [status, progress] of [["running", 50], ["reviewing", 50], ["done", 100], ["failed", 0], ["needs_human_review", 0], ["cancelled", 0], ["pending", 0]]) {
    current.state.persisted.status = status;
    await assertProjections(current, status, progress);
  }
});

test("no persisted status or execution identity is untracked rather than falsely pending", async () => {
  const current = fixture();
  current.state.persisted = undefined;
  await assertProjections(current, "untracked", 0);
  current.state.persisted = { project_id: current.ticket.project_id, status: "done", details: {} };
  await assertProjections(current, "untracked", 0);
});

test("another immutable plan execution cannot appear completed in View or graph", async () => {
  for (const patch of [{ plan_revision: 2 }, { plan_sha256: "b".repeat(64) }, { sprint_id: "SPRINT-OTHER" }, { plan_id: "PLAN-OTHER" }, { project_id: "PROJECT-OTHER" }]) {
    const current = fixture();
    current.state.persisted.status = "done";
    Object.assign(current.state.persisted.details.execution_basis, patch);
    await assertProjections(current, "untracked", 0);
  }
});

test("foreign project runtime status is rejected across all projections", async () => {
  const current = fixture();
  current.state.persisted.project_id = "PROJECT-OTHER";
  const { service, ticket } = current;
  for (const read of [() => service.getTicket(ticket.project_id, ticket.id), () => service.getTicketGraph(ticket.project_id, ticket.id), () => service.getDashboard(ticket.project_id)]) {
    await assert.rejects(read(), { code: "TICKET_PLAN_SCOPE", statusCode: 409 });
  }
});

test("View reads latest runtime state each time without modifying the approved ticket", async () => {
  const current = fixture();
  const first = await current.service.getTicket(current.ticket.project_id, current.ticket.id);
  assert.equal(first.status, "running");
  current.state.persisted.status = "done";
  first.acceptance_criteria.push("Not approved");
  await assertProjections(current, "done", 100);
});

test("ticket detail API and project-scoped graph API expose current runtime status", async () => {
  const current = fixture();
  const router = createForgeV1Router({ projectDashboardService: current.service });
  for (const status of ["running", "failed", "done"]) {
    current.state.persisted.status = status;
    for (const path of ["/forge/v1/tickets/TICKET-1?project=PROJECT-1", "/forge/v1/projects/PROJECT-1/tickets/TICKET-1"]) {
      const response = await router.route("GET", new URL(path, "http://localhost"), { headers: {} });
      assert.equal(response.status, 200);
      assert.equal(response.body.status, status);
    }
    const graph = await router.route("GET", new URL("/forge/v1/projects/PROJECT-1/tickets/TICKET-1/graph", "http://localhost"), { headers: {} });
    assert.equal(graph.status, 200);
    assert.equal(graph.body.ticket.status, status);
  }
});
