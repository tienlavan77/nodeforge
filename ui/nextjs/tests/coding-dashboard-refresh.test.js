// Prevents ticket RUN status refreshes from unmounting the Sprint UI or redispatching work.
import assert from "node:assert/strict";
import test from "node:test";
import { createCodingDashboardLoader } from "../lib/coding-dashboard-loader.js";

const snapshot = { project_id: "P", roadmap: { sprints: [
  { id: "S", tasks: [{ id: "A", status: "planned" }] },
  { id: "OTHER", tasks: [{ id: "B", status: "planned" }] }
] } };

// Captures dashboard visibility and requests while a ticket changes execution phase.
function fixture() {
  const states = [];
  const reads = [];
  const loader = createCodingDashboardLoader({ projectId: "P", onState: (state) => states.push(state), logger: () => {}, client: {
    getProjectDashboard: (projectId) => new Promise((resolve, reject) => reads.push({ projectId, resolve, reject })),
    runTicket: () => assert.fail("A refresh must not run any ticket"),
    runSprint: () => assert.fail("A refresh must not run a Sprint")
  } });
  return { loader, states, reads };
}

test("initial load shows loading, but ticket status refresh keeps Sprint UI mounted", async () => {
  const f = fixture();
  const initial = f.loader.load();
  assert.deepEqual(f.states.map((state) => state.status), ["loading"]);
  f.reads[0].resolve(snapshot); await initial;
  const visible = f.states.at(-1);
  const refresh = f.loader.load();
  assert.equal(f.states.at(-1), visible);
  assert.deepEqual(visible.dashboard, snapshot);
  const updated = structuredClone(snapshot);
  updated.roadmap.sprints[0].tasks[0].status = "running";
  f.reads[1].resolve(updated); await refresh;
  assert.deepEqual(f.states.map((state) => state.status), ["loading", "ready", "ready"]);
  assert.equal(f.states.at(-1).dashboard.roadmap.sprints[0].tasks[0].status, "running");
  assert.deepEqual(f.states.at(-1).dashboard.roadmap.sprints[1], snapshot.roadmap.sprints[1]);
  assert.ok(f.reads.every((read) => read.projectId === "P"));
});

test("newest status response wins without intermediate loading resets", async () => {
  const f = fixture(); const initial = f.loader.load();
  f.reads[0].resolve(snapshot); await initial;
  const older = f.loader.load(); const newer = f.loader.load();
  const completed = structuredClone(snapshot);
  completed.roadmap.sprints[0].tasks[0].status = "done";
  f.reads[2].resolve(completed); await newer;
  const visible = f.states.at(-1);
  f.reads[1].resolve(snapshot); await older;
  assert.equal(f.states.at(-1), visible);
  assert.equal(visible.dashboard.roadmap.sprints[0].tasks[0].status, "done");
  assert.equal(f.states.filter((state) => state.status === "loading").length, 1);
});

test("manual refresh also preserves an already displayed Sprint", async () => {
  const f = fixture(); const initial = f.loader.load();
  f.reads[0].resolve(snapshot); await initial;
  const visible = f.states.at(-1); const refresh = f.loader.load({ manual: true });
  assert.equal(f.states.at(-1), visible);
  f.reads[1].resolve(snapshot); await refresh;
  assert.equal(f.states.at(-1).status, "ready");
});

test("reconciliation failure still hides RUN controls and blocks automatic retries", async () => {
  const f = fixture(); const initial = f.loader.load();
  f.reads[0].resolve(snapshot); await initial;
  const refresh = f.loader.load();
  f.reads[1].reject(Object.assign(new Error("Reconcile scope"), { code: "SPRINT_REGISTRY_CONFLICT", retryable: false }));
  await refresh;
  assert.equal(f.states.at(-1).status, "error");
  assert.equal(f.states.at(-1).dashboard, null);
  await f.loader.load();
  assert.equal(f.reads.length, 2);
});

test("unmount invalidates a background refresh", async () => {
  const f = fixture(); const initial = f.loader.load();
  f.reads[0].resolve(snapshot); await initial;
  const refresh = f.loader.load(); const visible = f.states.at(-1);
  f.loader.cancel(); f.reads[1].resolve(snapshot); await refresh;
  assert.equal(f.states.at(-1), visible);
});
