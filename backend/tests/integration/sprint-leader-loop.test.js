import assert from "node:assert/strict";
import test from "node:test";

import { createSprintLeaderLoop } from "../../src/modules/workflows/sprint-leader-loop.js";

test("requests a next sprint and accepts a schema-valid Sprint Leader proposal", () => {
  const loop = createSprintLeaderLoop({
    projectId: "PROJECT-sprint-loop",
    createRequestId: () => "REQ-sprint-loop-001",
    createEventId: () => "EVT-sprint-loop-001",
    clock: () => new Date("2026-08-19T12:00:00Z")
  });
  const command = loop.requestPlan({ completedSprintId: "SPRINT-6", objective: "Build the next delivery increment." });
  assert.equal(command.type, "sprints.request_plan");

  const accepted = loop.acceptPlan({
    event_id: "EVT-sprint-loop-001",
    type: "sprints.plan_proposed",
    project_id: "PROJECT-sprint-loop",
    request_id: command.request_id,
    timestamp: "2026-08-19T12:00:01Z",
    payload: {
      sprint: {
        id: "SPRINT-7",
        objective: "Build the next delivery increment.",
        commits: [{ id: "NF-078", order: 1, objective: "Implement the next increment.", acceptance_criteria: ["Integration passes."] }]
      }
    }
  });
  assert.equal(accepted.sprint.id, "SPRINT-7");
  assert.equal(accepted.sprint.commits[0].id, "NF-078");
});

test("rejects malformed or cross-project Sprint Leader proposals", () => {
  const loop = createSprintLeaderLoop({ projectId: "PROJECT-sprint-loop" });
  const base = { event_id: "EVT-sprint-loop-002", type: "sprints.plan_proposed", project_id: "PROJECT-sprint-loop", timestamp: "2026-08-19T12:00:01Z", payload: { sprint: { id: "SPRINT-7", objective: "Next", commits: [] } } };
  assert.throws(() => loop.acceptPlan({ ...base, project_id: "PROJECT-other" }), /different project/);
  assert.throws(() => loop.acceptPlan(base), /Invalid sprint/);
});

test("generates unique request and event IDs by default", () => {
  const first = createSprintLeaderLoop({ projectId: "PROJECT-sprint-loop" }).requestPlan({ completedSprintId: "SPRINT-1" });
  const second = createSprintLeaderLoop({ projectId: "PROJECT-sprint-loop" }).requestPlan({ completedSprintId: "SPRINT-1" });
  assert.notEqual(first.request_id, second.request_id);
});
