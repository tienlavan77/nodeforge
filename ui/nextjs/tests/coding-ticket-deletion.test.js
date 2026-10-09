// Verifies ticket deletion updates Coding cards locally and preserves server revision identity without dashboard reload.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCodingDashboardLoader } from "../lib/coding-dashboard-loader.js";

const snapshot = { project_id: "P", roadmap: { sprints: [
  { id: "S", version: 0, status: "ready", plan_id: "PLAN-S", plan_revision: 1, plan_sha256: "old", ticket_ids: ["A", "B"], tasks: [{ id: "A", status: "planned", progress: 0 }, { id: "B", status: "done", progress: 100 }] },
  { id: "OTHER", version: 0, tasks: [{ id: "C" }] }
] } };
const receipt = { deleted: true, ticket_id: "A", sprint_id: "S", version: 1, status: "awaiting_human_approval", plan_id: "PLAN-S", plan_revision: 2, plan_sha256: "new" };

// Captures local state changes while counting all dashboard requests.
function fixture(read = async () => snapshot) {
  const states = []; let reads = 0;
  const loader = createCodingDashboardLoader({ projectId: "P", onState: (state) => states.push(state), logger: () => {},
    client: { getProjectDashboard: () => { reads += 1; return read(); } } });
  return { loader, states, reads: () => reads };
}

test("deletion removes only one ticket, keeps unrelated Sprint reference and applies new approval basis", async () => {
  const f = fixture(); await f.loader.load(); f.states.length = 0;
  f.loader.removeTicket("A", receipt);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.states.map((state) => state.status), ["ready"]);
  const [changed, other] = f.states.at(-1).dashboard.roadmap.sprints;
  assert.equal(other, snapshot.roadmap.sprints[1]);
  assert.deepEqual(changed.ticket_ids, ["B"]);
  assert.deepEqual(changed.tasks.map((ticket) => ticket.id), ["B"]);
  for (const key of ["version", "status", "plan_id", "plan_revision", "plan_sha256"]) assert.equal(changed[key], receipt[key]);
  assert.equal(changed.tasks[0].status, "untracked");
  assert.equal(changed.tasks[0].progress, 0);
  assert.equal(snapshot.roadmap.sprints[0].tasks.length, 2);
  f.loader.removeTicket("A", receipt);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.states.at(-1).dashboard.roadmap.sprints[0].ticket_ids, ["B"]);
});

test("pending full read cannot overwrite a confirmed deletion", async () => {
  let resolve;
  let first = true;
  const f = fixture(() => { if (first) { first = false; return Promise.resolve(snapshot); } return new Promise((done) => { resolve = done; }); });
  await f.loader.load(); const pending = f.loader.load();
  f.loader.removeTicket("A", receipt); const after = f.states.at(-1);
  resolve(snapshot); await pending;
  assert.equal(f.states.at(-1), after);
});

test("deletion before initial load filters stale snapshots but permits a later explicit replan to re-add the ticket", async () => {
  let response = snapshot;
  const f = fixture(async () => response);
  f.loader.removeTicket("A", receipt);
  assert.equal(f.states.length, 0);
  await f.loader.load();
  assert.deepEqual(f.states.at(-1).dashboard.roadmap.sprints[0].ticket_ids, ["B"]);
  await f.loader.load({ manual: true });
  assert.equal(f.states.at(-1).dashboard.roadmap.sprints[0].plan_revision, 2);
  response = structuredClone(snapshot); response.roadmap.sprints[0].plan_revision = 3; response.roadmap.sprints[0].version = 2;
  await f.loader.load({ manual: true });
  assert.deepEqual(f.states.at(-1).dashboard.roadmap.sprints[0].ticket_ids, ["A", "B"]);
  f.loader.removeTicket("A", receipt);
  assert.deepEqual(f.states.at(-1).dashboard.roadmap.sprints[0].ticket_ids, ["A", "B"]);
});

test("older duplicate receipts cannot downgrade current deletion metadata", async () => {
  const f = fixture(); await f.loader.load();
  f.loader.removeTicket("A", receipt);
  const after = f.states.at(-1);
  f.loader.removeTicket("A", { ...receipt, version: 0, plan_revision: 1 });
  assert.equal(f.states.at(-1), after);
  f.loader.removeTicket("A", { ...receipt, project_id: "OTHER" });
  assert.equal(f.states.at(-1), after);
});

test("deletion retains a nonretryable reconciliation diagnostic", async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw Object.assign(new Error("Reconcile scope"), { retryable: false, code: "SPRINT_REGISTRY_CONFLICT" }); return snapshot; });
  await f.loader.load(); fail = true; await f.loader.load();
  const error = f.states.at(-1);
  f.loader.removeTicket("A", receipt);
  assert.equal(f.states.at(-1), error);
  await f.loader.load(); assert.equal(f.reads(), 2);
});

test("successful DELETE and scoped SSE use the same local callback without refreshing the dashboard", async () => {
  const page = await readFile("ui/nextjs/app/coding/page.jsx", "utf8");
  const monitor = await readFile("ui/nextjs/components/coding-workspace-monitor.jsx", "utf8");
  const card = await readFile("ui/nextjs/components/ticket-detail-modal.jsx", "utf8");
  const stream = await readFile("ui/nextjs/lib/home-page-event-stream.js", "utf8");
  assert.match(page, /dashboardLoader\.removeTicket\(ticketId, receipt\)/);
  assert.match(page, /onSprintDeleted, onTicketDeleted, agentDisplayName/);
  assert.match(monitor, /onTicketDeleted=\{onTicketDeleted\}/);
  const remove = card.slice(card.indexOf("async function remove()"), card.indexOf("async function stop()"));
  assert.match(remove, /await client\.deleteTicket[\s\S]*onDeleted\?\.\(ticket\.id, \{ \.\.\.result/);
  assert.doesNotMatch(remove, /onRefresh/);
  assert.match(stream, /event\.event_type === "ticket.deleted" && onTicketDeleted/);
  assert.match(stream, /onTicketDeleted\(event\.payload\.ticket_id, event\.payload\)/);
});
