// Ensure workspace monitors show activity only for agents assigned to their page role.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

// Shows only the selected agent, including when switching between agents sharing the same role.
test("filters activities by selected agent without leaking other agents or unbound events", () => {
  const agents = [
    { agent_id: "architect-a", role: "architecture_manager" },
    { id: "architect-b", role: "architecture_manager" },
    { agent_id: "engineer-a", role: "system_engineer" },
    { id: "engineer-b", role: "system_engineer" }
  ];
  const activities = agents.map((agent) => ({ payload: { agent_id: agent.agent_id ?? agent.id } }));
  activities.push({}, { payload: {} }, { payload: { agent_id: "unknown" } });
  for (const [index, agent] of agents.entries()) {
    assert.deepEqual(monitorAgentActivities(activities, agents, agent.role, agent.agent_id ?? agent.id), [activities[index]]);
  }
  for (const selectedAgentId of ["", null, "unknown", "engineer-a"]) {
    assert.deepEqual(monitorAgentActivities(activities, agents, "architecture_manager", selectedAgentId), []);
  }
  assert.deepEqual(monitorAgentActivities(activities, agents, "architecture_manager"), activities.slice(0, 2));
});

// Connects both page selections to the filter used by activity rows and the activity indicator.
test("home and system monitors receive the selected page agent", async () => {
  const home = await readFile(new URL("../components/architecture-workspace.jsx", import.meta.url), "utf8");
  const system = await readFile(new URL("../app/system/page.jsx", import.meta.url), "utf8");
  const monitor = await readFile(new URL("../components/WorkspaceMonitorPanels.jsx", import.meta.url), "utf8");
  assert.match(home, /<WorkspaceMonitorPanels[^>]*selectedAgentId=\{selectedArchitectureManager\?\.id \?\? ""\}/);
  assert.match(system, /<WorkspaceMonitorPanels[^>]*selectedAgentId=\{selectedAgent\?\.id \?\? ""\}/);
  assert.match(monitor, /monitorAgentActivities\([^;]*selectedAgentId\)/);
  assert.match(monitor, /latestAgentEvent = visibleActivities\.at\(-1\)/);
  assert.match(monitor, /visibleActivities\.slice\(\)\.reverse\(\)\.map/);
});
