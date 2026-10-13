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

// Resolves newly planned tickets without a legacy roadmap projection while retaining approval and dependency fences.
test("Registry intake reads immutable ticket and never falls back to stale roadmap", async () => {
  const canonical = { ...ticket("TICKET-NEW"), sprint_id: "SPRINT-NEW", title: "Approved title" };
  const record = { project_id: "PROJECT-1", sprint_id: "SPRINT-NEW", version: 2 };
  const service = createSprintLeaderIntakeService({
    fileService: { readForIndex: async () => ({ content: "Rules" }) },
    roadmaps: { getCurrent: () => { throw new Error("Must not read legacy roadmap"); } },
    sprintRegistry: { getByTicket: async () => record, assertReady: async (id, options) => { assert.equal(id, record.sprint_id); assert.equal(options.expectedVersion, 2); return { plan: { content: { tickets: [canonical.id], ticket_specs: [canonical] } } }; } },
  });
  const result = await service.open({ projectId: "PROJECT-1", ticketId: canonical.id });
  assert.equal(result.ticket.title, "Approved title");
  result.ticket.title = "Mutated";
  assert.equal(canonical.title, "Approved title");
});

// Never turns stale legacy content into RUN authority when registered scope is absent, foreign or unapproved.
test("Registry intake preserves not-found and approval gates", async () => {
  for (const mode of ["missing", "foreign", "unapproved", "missing-spec", "dependency"]) {
    const canonical = { ...ticket("TICKET-NEW", mode === "dependency" ? ["TICKET-DEP"] : []), sprint_id: "SPRINT-NEW" };
    const service = createSprintLeaderIntakeService({
      fileService: { readForIndex: async () => ({ content: "Rules" }) },
      roadmaps: { getCurrent: () => { throw new Error("Must not read legacy roadmap"); } },
      ticketStatusStore: { get: () => null },
      sprintRegistry: {
        getByTicket: async () => mode === "missing" ? null : { project_id: mode === "foreign" ? "PROJECT-OTHER" : "PROJECT-1", sprint_id: "SPRINT-NEW", version: 1 },
        assertReady: async () => { if (mode === "unapproved") throw Object.assign(new Error("Approval required"), { code: "PLAN_APPROVAL_REQUIRED" }); return { plan: { content: { tickets: [canonical.id], ticket_specs: mode === "missing-spec" ? [] : [canonical] } } }; },
      },
    });
    await assert.rejects(service.open({ projectId: "PROJECT-1", ticketId: canonical.id }), { code: mode === "unapproved" ? "PLAN_APPROVAL_REQUIRED" : mode === "dependency" ? "TICKET_EXECUTION_RECONCILIATION_REQUIRED" : "TICKET_NOT_FOUND" });
  }
});

test("blocks a ticket while a dependency is unfinished", async () => {
  const service = harness([ticket("NF-001", [], "planned"), ticket("NF-002", ["NF-001"]) ]);
  await assert.rejects(() => service.open({ projectId: "PROJECT-1", ticketId: "NF-002" }), (error) => error.code === "SPRINT_DEPENDENCIES_NOT_READY" && error.blocked_by[0].id === "NF-001");
});
