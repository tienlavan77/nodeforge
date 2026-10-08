// Ensure workspace monitors show activity only for agents assigned to their page role.
import assert from "node:assert/strict";
import test from "node:test";
import { monitorAgentActivities } from "../lib/monitor-agent-activities.js";

// Keep architecture and system engineer activity separate across monitor pages.
test("filters project agent activities by configured role", () => {
  const agents = [
    { agent_id: "architect", role: "architecture_manager" },
    { agent_id: "engineer", role: "system_engineer" },
    { id: "other", role: "coder" },
  ];
  const activities = ["architect", "engineer", "other", "unknown"].map((agent_id) => ({ payload: { agent_id } }));
  assert.deepEqual(monitorAgentActivities(activities, agents, "architecture_manager"), [activities[0]]);
  assert.deepEqual(monitorAgentActivities(activities, agents, "system_engineer"), [activities[1]]);
  assert.deepEqual(monitorAgentActivities(activities, agents, ["coder", "reviewer", "sprint_leader"]), [activities[2]]);
  assert.deepEqual(monitorAgentActivities(activities, [], "system_engineer"), []);
});
