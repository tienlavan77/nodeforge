// Prevents repeated full-plan reads from Coding activity while preserving exact approval and reconnect reconciliation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { codingPlanRefresh } from "../lib/coding-plan-events.js";
import { createCodingPlanLoader } from "../lib/coding-plan-loader.js";

// Provides mutable server state and request counters without launching tickets or calling the live API.
function fixture(options = {}) {
  const heads = ["A", "B"].map((id) => ({ project_id: "PROJECT", plan_id: id, sprint_id: `SPRINT-${id}`, revision: 1, sha256: "a".repeat(64) }));
  const documents = new Map(heads.map((head) => [head.plan_id, { ...head, status: "awaiting_human_approval" }]));
  const reads = []; const snapshots = [];
  const client = { listPlans: async () => heads, getPlanRevision: async (_project, id) => { reads.push(id); return structuredClone(documents.get(id)); } };
  const loader = createCodingPlanLoader({ client, projectId: "PROJECT", onState: (snapshot) => snapshots.push(snapshot), ...options });
  return { heads, documents, reads, snapshots, client, loader };
}

test("ticket activity and stream noise do not trigger plan reconciliation", () => {
  for (const event_type of ["agent.activity", "ticket.status_changed", "conversation.message.delta", "stream.error", "stream.snapshot", "stream.heartbeat"]) {
    assert.equal(codingPlanRefresh({ project_id: "PROJECT", event_type }, "PROJECT"), null);
  }
  assert.equal(codingPlanRefresh({ project_id: "OTHER", event_type: "plan.request.persisted" }, "PROJECT"), null);
  assert.deepEqual(codingPlanRefresh({ project_id: "PROJECT", event_type: "stream.connected" }, "PROJECT"), { refresh: true, ifStale: true });
});

test("planning progress reuses details while persisted plans and Sprint changes target their own identities", () => {
  assert.deepEqual(codingPlanRefresh({ project_id: "PROJECT", event_type: "plan.request.generating" }, "PROJECT"), { refresh: false, planIds: [] });
  assert.deepEqual(codingPlanRefresh({ project_id: "PROJECT", event_type: "plan.request.persisted", payload: { plan_id: "A" } }, "PROJECT"), { refresh: false, planIds: ["A"] });
  assert.deepEqual(codingPlanRefresh({ project_id: "PROJECT", event_type: "sprint.updated", payload: { sprint_id: "SPRINT-A" } }, "PROJECT"), { refresh: false, sprintIds: ["SPRINT-A"] });
});

test("repeated progress refreshes do not fetch unchanged plan revisions", async () => {
  const { loader, reads, snapshots } = fixture();
  await loader.load();
  for (let index = 0; index < 5; index++) await loader.load({ refresh: false });
  assert.deepEqual(reads, ["A", "B"]);
  assert.equal(snapshots.at(-1).plans.length, 2);
});

test("rapid tab returns and duplicate connection events do not repeatedly list or read plans", async () => {
  let clock = 1000; let lists = 0;
  const { loader, client, reads } = fixture({ now: () => clock });
  const listPlans = client.listPlans;
  client.listPlans = async (...args) => { lists++; return listPlans(...args); };
  const initial = loader.load({ ifStale: true });
  assert.equal(loader.load({ ifStale: true }), initial);
  await initial;
  for (let index = 0; index < 15; index++) await loader.load({ ifStale: true });
  assert.equal(lists, 1);
  assert.deepEqual(reads, ["A", "B"]);
  clock += 30000;
  await loader.load({ ifStale: true });
  assert.equal(lists, 2);
  assert.deepEqual(reads, ["A", "B", "A", "B"]);
});

test("plan changes and explicit owner refresh bypass the background freshness window", async () => {
  const { loader, reads, documents, snapshots } = fixture({ now: () => 1000 });
  await loader.load({ ifStale: true });
  documents.get("A").status = "approved";
  await loader.load({ refresh: false, planIds: ["A"] });
  assert.deepEqual(reads, ["A", "B", "A"]);
  assert.deepEqual(snapshots.at(-1).plans.map((plan) => plan.plan_id), ["B"]);
  await loader.load();
  assert.deepEqual(reads, ["A", "B", "A", "A", "B"]);
});

test("a failed background reconciliation is retried even within the freshness window", async () => {
  const { loader, client, snapshots } = fixture({ now: () => 1000 });
  await loader.load();
  const listPlans = client.listPlans;
  client.listPlans = async () => { throw new Error("offline"); };
  await loader.load();
  assert.equal(snapshots.at(-1).status, "error");
  client.listPlans = listPlans;
  await loader.load({ ifStale: true });
  assert.equal(snapshots.at(-1).status, "ready");
});

test("new revision, checksum or plan fetches only the changed detail", async () => {
  const { loader, heads, reads, documents } = fixture();
  await loader.load();
  heads[0].revision = 2; documents.get("A").revision = 2;
  await loader.load({ refresh: false });
  heads[1].sha256 = "b".repeat(64); documents.get("B").sha256 = heads[1].sha256;
  await loader.load({ refresh: false });
  heads.push({ ...heads[0], plan_id: "C" }); documents.set("C", { ...heads[2], status: "awaiting_human_approval" });
  await loader.load({ refresh: false });
  assert.deepEqual(reads, ["A", "B", "A", "B", "C"]);
});

test("a Sprint update refreshes its child and Architecture handoff, not other Sprint Plans", async () => {
  const { loader, heads, reads, documents, snapshots } = fixture();
  heads.push({ plan_id: "PARENT", format: "markdown", revision: 1, sha256: "c".repeat(64), sprint_id: null });
  documents.set("PARENT", { ...heads[2], sprint_id: "SPRINT-A", status: "approved", handoff_status: "completed", readiness_status: "pending" });
  await loader.load();
  documents.get("A").status = "approved"; documents.get("PARENT").readiness_status = "established";
  await loader.load({ refresh: false, sprintIds: ["SPRINT-A"] });
  assert.deepEqual(reads, ["A", "B", "PARENT", "A", "PARENT"]);
  assert.deepEqual(snapshots.at(-1).plans.map((plan) => plan.plan_id), ["B"]);
});

test("focus, reconnect and explicit refresh still reconcile approval changes on unchanged bytes", async () => {
  const { loader, reads, documents, snapshots } = fixture();
  await loader.load(); documents.get("A").status = "approved";
  await loader.load();
  assert.deepEqual(reads, ["A", "B", "A", "B"]);
  assert.deepEqual(snapshots.at(-1).plans.map((plan) => plan.plan_id), ["B"]);
});

test("new Sprint handoff also reconciles an Architecture plan whose child was previously unknown", async () => {
  const { loader, heads, documents, reads, snapshots } = fixture();
  heads.push({ plan_id: "PARENT", format: "markdown", revision: 1, sha256: "c".repeat(64) });
  documents.set("PARENT", { ...heads[2], status: "awaiting_human_approval" });
  await loader.load();
  documents.set("PARENT", { ...heads[2], status: "approved", sprint_id: "SPRINT-A", handoff_status: "completed", readiness_status: "established" });
  await loader.load({ refresh: false, sprintIds: ["SPRINT-A"] });
  assert.deepEqual(reads, ["A", "B", "PARENT", "A", "PARENT"]);
  assert.equal(snapshots.at(-1).plans.some((plan) => plan.plan_id === "PARENT"), false);
});

test("a failed authoritative refresh cannot be repaired by merely reusing old cached details", async () => {
  const { loader, client, reads, documents, snapshots } = fixture();
  await loader.load();
  const getRevision = client.getPlanRevision;
  client.getPlanRevision = async () => { throw new Error("offline"); };
  await loader.load(); assert.equal(snapshots.at(-1).status, "error");
  client.getPlanRevision = getRevision; documents.get("A").status = "approved";
  await loader.load({ refresh: false });
  assert.deepEqual(reads, ["A", "B", "A", "B"]);
  assert.deepEqual(snapshots.at(-1).plans.map((plan) => plan.plan_id), ["B"]);
});

test("completed or removed revisions are evicted and cannot remain cached after rediscovery", async () => {
  const { loader, heads, reads } = fixture();
  await loader.load(); const removed = heads.pop();
  await loader.load({ refresh: false }); heads.push(removed);
  await loader.load({ refresh: false });
  assert.deepEqual(reads, ["A", "B", "B"]);
});

test("Coding coalesces scoped invalidations and defers network loads until the tab is visible", async () => {
  const component = await readFile(new URL("../components/coding-architecture-plans.jsx", import.meta.url), "utf8");
  assert.match(component, /codingPlanRefresh\(event, projectId\)/);
  assert.match(component, /document.visibilityState !== "hidden"/);
  assert.match(component, /if \(document.visibilityState === "hidden"\) return/);
  assert.match(component, /pending\?\.planIds/);
  assert.doesNotMatch(component, /setInterval/);
});
