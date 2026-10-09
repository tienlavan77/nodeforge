// Verifies confirmed Coding Sprint deletions update locally without dashboard refetch or stale-response resurrection.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCodingDashboardLoader } from "../lib/coding-dashboard-loader.js";

const dashboard = { project_id: "PROJECT-A", roadmap: { id: "ROADMAP-A", sprints: [{ id: "SPRINT-A", tasks: [{ id: "TICKET-A" }] }, { id: "SPRINT-B", tasks: [{ id: "TICKET-B" }] }] } };

// Controls an in-flight dashboard read to reproduce deletion racing a delayed server response.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("confirmed deletion removes only its Sprint without loading state or another request", async () => {
  const states = []; let reads = 0;
  const loader = createCodingDashboardLoader({ projectId: "PROJECT-A", onState: (state) => states.push(state), client: { getProjectDashboard: async () => { reads += 1; return dashboard; } } });
  await loader.load();
  const initial = states.at(-1).dashboard;
  states.length = 0;
  loader.removeSprint("SPRINT-A");
  assert.equal(reads, 1);
  assert.deepEqual(states.map((state) => state.status), ["ready"]);
  assert.deepEqual(states.at(-1).dashboard.roadmap.sprints.map((sprint) => sprint.id), ["SPRINT-B"]);
  assert.equal(states.at(-1).dashboard.roadmap.sprints[0], initial.roadmap.sprints[1]);
  assert.equal(dashboard.roadmap.sprints.length, 2);
  loader.removeSprint("SPRINT-A");
  assert.equal(reads, 1);
  assert.equal(states.at(-1).dashboard.roadmap.sprints.length, 1);
});

test("in-flight read cannot resurrect a deleted Sprint or replace unrelated card data", async () => {
  const states = []; const delayed = deferred(); let reads = 0;
  const loader = createCodingDashboardLoader({ projectId: "PROJECT-A", onState: (state) => states.push(state), client: { getProjectDashboard: () => ++reads === 1 ? Promise.resolve(dashboard) : delayed.promise } });
  await loader.load();
  const pending = loader.load();
  loader.removeSprint("SPRINT-A");
  const afterDelete = states.at(-1);
  delayed.resolve(dashboard); await pending;
  assert.equal(states.at(-1), afterDelete);
  assert.deepEqual(afterDelete.dashboard.roadmap.sprints.map((sprint) => sprint.id), ["SPRINT-B"]);
});

test("deletion before first snapshot and subsequent stale snapshot remain filtered", async () => {
  const states = [];
  const loader = createCodingDashboardLoader({ projectId: "PROJECT-A", onState: (state) => states.push(state), client: { getProjectDashboard: async () => dashboard } });
  loader.removeSprint("SPRINT-A");
  assert.equal(states.length, 0);
  await loader.load();
  assert.deepEqual(states.at(-1).dashboard.roadmap.sprints.map((sprint) => sprint.id), ["SPRINT-B"]);
  await loader.load({ manual: true });
  assert.deepEqual(states.at(-1).dashboard.roadmap.sprints.map((sprint) => sprint.id), ["SPRINT-B"]);
  loader.removeSprint("SPRINT-B");
  assert.deepEqual(states.at(-1).dashboard.roadmap.sprints, []);
});

test("local deletion does not dismiss an existing reconciliation diagnostic", async () => {
  const states = []; let reads = 0;
  const loader = createCodingDashboardLoader({ projectId: "PROJECT-A", logger: () => {}, onState: (state) => states.push(state), client: { getProjectDashboard: async () => {
    if (++reads === 1) return dashboard;
    throw Object.assign(new Error("Reconcile source"), { code: "SPRINT_REGISTRY_CONFLICT", retryable: false, scope: "scoped" });
  } } });
  await loader.load(); await loader.load();
  const diagnostic = states.at(-1);
  loader.removeSprint("SPRINT-A");
  assert.equal(states.at(-1), diagnostic);
  assert.equal(diagnostic.status, "error");
  await loader.load(); assert.equal(reads, 2);
});

test("Coding wires local success/SSE callbacks; other pages retain their refresh fallback", async () => {
  const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
  const monitor = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../components/sprint-plan-panels.jsx", import.meta.url), "utf8");
  const stream = await readFile(new URL("../lib/home-page-event-stream.js", import.meta.url), "utf8");
  assert.match(page, /dashboardLoader\.removeSprint\(sprintId\)/);
  assert.match(page, /<CodingWorkspaceMonitor[^>]*onSprintDeleted=\{onSprintDeleted\}/);
  assert.match(monitor, /<SprintPlanDashboard[^>]*onSprintDeleted=\{onSprintDeleted\}/);
  const handler = panel.slice(panel.indexOf("async function handleDelete"), panel.indexOf("return <section className=\"sprint-plan-dashboard\""));
  assert.match(handler, /await client\.deleteSprintPlan/);
  assert.match(handler, /if \(onSprintDeleted\) onSprintDeleted\(sprintId\);\s*else await onRefresh\?\.\(\)/);
  assert.ok(handler.indexOf("await client.deleteSprintPlan") < handler.indexOf("onSprintDeleted(sprintId)"));
  assert.match(stream, /event\.event_type === "sprint.deleted" && onSprintDeleted/);
  assert.match(stream, /onSprintDeleted\(event\.payload\.sprint_id\);\s*\} else if/);
});
