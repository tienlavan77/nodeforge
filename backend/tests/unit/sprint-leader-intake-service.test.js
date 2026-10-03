// Verifies Sprint Leader dependency gating before ticket dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { createSprintLeaderIntakeService } from "../../src/application/sprint-leader-intake-service.js";

const ticket = (id, dependencies = [], status = "planned") => ({ id, project_id: "PROJECT-1", dependencies, status });

// Builds an intake service fixture with a small in-memory roadmap.
function harness(tickets) {
  return createSprintLeaderIntakeService({
    fileService: { readForIndex: async () => ({ content: "Sprint Leader rules" }) },
    roadmaps: { getCurrent: () => ({ sprints: [{ tickets }] }) }
  });
}

test("opens a ticket after all dependencies are done", async () => {
  const service = harness([ticket("NF-001", [], "done"), ticket("NF-002", ["NF-001"]) ]);
  const result = await service.open({ projectId: "PROJECT-1", ticketId: "NF-002" });
  assert.equal(result.ticket.id, "NF-002");
  assert.deepEqual(result.dependencies, ["NF-001"]);
  assert.equal(result.rules_path, "workflows/agents/sprint-leader/README.md");
});

test("blocks a ticket while a dependency is unfinished", async () => {
  const service = harness([ticket("NF-001", [], "planned"), ticket("NF-002", ["NF-001"]) ]);
  await assert.rejects(() => service.open({ projectId: "PROJECT-1", ticketId: "NF-002" }), (error) => error.code === "SPRINT_DEPENDENCIES_NOT_READY" && error.blocked_by[0].id === "NF-001");
});
