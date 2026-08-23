import assert from "node:assert/strict";
import test from "node:test";

import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";

test("stores roadmap versions append-only and returns the latest version", () => {
  const store = createRoadmapStore();
  const first = roadmap("1.0.0");
  const second = roadmap("1.1.0");
  store.save(first);
  store.save(second);
  first.goals[0] = "mutated";

  assert.equal(store.getCurrent().version, "1.1.0");
  assert.equal(store.getVersion("1.0.0").goals[0], "Ship governance foundation.");
  assert.deepEqual(store.getAllVersions().map(({ version }) => version), ["1.0.0", "1.1.0"]);
  assert.throws(() => store.save(second), /version already exists/);
});

test("rejects invalid roadmaps before storing them", () => {
  const store = createRoadmapStore();
  const invalid = roadmap("2.0.0");
  delete invalid.sprints;
  assert.throws(() => store.save(invalid), /Invalid Roadmap/);
  assert.equal(store.getAllVersions().length, 0);
});

test("persists ticket status transitions in a new roadmap version", () => {
  const store = createRoadmapStore();
  store.save(roadmap("1.0.0"));
  const updated = store.updateTicketStatus({ projectId: "PROJECT-115", ticketId: "NF-115", status: "done" });
  assert.equal(updated.sprints[0].tickets[0].status, "done");
  assert.equal(store.getCurrent().sprints[0].tickets[0].status, "done");
});

function roadmap(version) {
  return {
    id: "ROADMAP-115",
    project_id: "PROJECT-115",
    version,
    goals: ["Ship governance foundation."],
    sprints: [{
      id: "SPRINT-11",
      roadmap_id: "ROADMAP-115",
      project_id: "PROJECT-115",
      objective: "Governance",
      tickets: [{
        id: "NF-115",
        project_id: "PROJECT-115",
        roadmap_id: "ROADMAP-115",
        sprint_id: "SPRINT-11",
        title: "Roadmap Store",
        objective: "Persist roadmap.",
        acceptance_criteria: ["Versions persist."],
        provenance: { source: "sprint_plan", source_id: "SPRINT-11", created_at: "2026-08-20T09:00:00Z" }
      }],
      exit_criteria: ["Tests pass"]
    }],
    created_at: "2026-08-20T09:00:00Z"
  };
}
