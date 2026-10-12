// Verifies Coding plan reconciliation and the direct authenticated API boundary without a conversation dependency.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { architecturePlanName, createCodingPlanLoader, reviewableArchitecturePlans } from "../lib/coding-plan-loader.js";

// Creates immutable plan snapshots without implying execution readiness.
function plan(id, date, status = "awaiting_human_approval") { return { plan_id: id, created_at: date, revision: 1, sha256: "a".repeat(64), format: "markdown", markdown: `# Plan: ${id}\n`, status }; }

test("pending plans sort newest first with deterministic tie-break and include failed approved handoffs", () => {
  const items = [plan("B", "2026-10-10"), plan("A", "2026-10-10"), plan("OLD", "2026-10-09", "approved"), { ...plan("DONE", "2026-10-11", "approved"), handoff_status: "completed", readiness_status: "established" }, plan("REJECT", "2026-10-12", "rejected")];
  assert.deepEqual(reviewableArchitecturePlans(items).map((item) => item.plan_id), ["A", "B", "OLD"]);
  assert.equal(architecturePlanName(items[0]), "B");
  assert.equal(architecturePlanName({ plan_id: "FALLBACK" }), "FALLBACK");
});

test("completed child stays recoverable until authoritative readiness is established", () => {
  const pending = { ...plan("PENDING", "2026-10-10", "approved"), handoff_status: "completed", readiness_status: "pending" };
  const legacy = { ...pending, plan_id: "LEGACY", readiness_status: undefined };
  assert.equal(reviewableArchitecturePlans([pending, legacy]).length, 2);
  assert.equal(reviewableArchitecturePlans([{ ...pending, readiness_status: "established" }]).length, 0);
});

test("diagnostics outage does not hide an authoritative persisted artifact", async () => {
  let snapshot;
  const loader = createCodingPlanLoader({ projectId: "PROJECT", client: { listPlans: async () => [plan("A", "2026-10-10")], getPlanRevision: async () => plan("A", "2026-10-10"), listPlanRequests: async () => { throw new Error("secret diagnostic error"); } }, onState: (state) => { snapshot = state; } });
  await loader.load();
  assert.equal(snapshot.status, "ready"); assert.equal(snapshot.plans[0].plan_id, "A");
  assert.equal(snapshot.diagnostics_error_code, "PLAN_DIAGNOSTICS_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(snapshot), /secret diagnostic/);
});

test("late and cancelled responses cannot overwrite a newer snapshot", async () => {
  let resolveFirst; let calls = 0; const snapshots = [];
  const client = { listPlans: () => ++calls === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve([plan("NEW", "2026-10-10")]), getPlanRevision: async (_, id) => plan(id, "2026-10-10") };
  const loader = createCodingPlanLoader({ client, projectId: "PROJECT", onState: (state) => snapshots.push(state) });
  const first = loader.load(); await loader.load(); resolveFirst([plan("OLD", "2026-10-09")]); await first;
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].plans[0].plan_id, "NEW");
  const deferred = createCodingPlanLoader({ client: { listPlans: () => new Promise((resolve) => { resolveFirst = resolve; }) }, projectId: "PROJECT", onState: () => assert.fail("cancelled callback") });
  const pending = deferred.load(); deferred.cancel(); resolveFirst([]); await pending;
});

test("snapshot failure preserves existing plans but marks them stale/error", async () => {
  const snapshots = []; let fail = false;
  const client = { listPlans: async () => { if (fail) throw new Error("offline"); return [plan("A", "2026-10-10")]; }, getPlanRevision: async () => plan("A", "2026-10-10") };
  const loader = createCodingPlanLoader({ client, projectId: "PROJECT", onState: (state) => snapshots.push(state) });
  await loader.load(); fail = true; await loader.load();
  assert.equal(snapshots[1].status, "error"); assert.equal(snapshots[1].plans[0].plan_id, "A"); assert.equal(snapshots[1].error, "offline");
});

test("Coding header lives outside dashboard loading and uses reconnect plus tab reconciliation", async () => {
  const component = await readFile(new URL("../components/coding-architecture-plans.jsx", import.meta.url), "utf8");
  const monitor = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");
  assert.ok(monitor.indexOf("<CodingArchitecturePlans") < monitor.indexOf("<CodingSprintDashboardState"));
  assert.match(component, /planEvents\?\.subscribe/); assert.match(component, /visibilitychange/); assert.match(component, /loader.cancel\(\)/);
  assert.doesNotMatch(component, /setInterval|connectProjectStream/);
  const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
  const stream = await readFile(new URL("../lib/home-page-event-stream.js", import.meta.url), "utf8");
  assert.match(page, /onProjectEvent: planEvents.publish/);
  assert.ok(stream.indexOf("onProjectEvent?.(event)") < stream.indexOf("activeConversationIdRef.current"));
  assert.doesNotMatch(component, /activeConversation|postOwnerMessage|localStorage|sessionStorage/);
  assert.match(component, /Continue handoff/);
  const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
  assert.match(component, /className="coding-architecture-plans" aria-label="Architecture plan approval"/);
  assert.match(component, /<ul className="coding-architecture-plan-list">\{visiblePlans.map/);
  assert.doesNotMatch(component, /<select|selectedId|setSelectedId/);
  assert.match(styles, /\.coding-architecture-plans \{[^}]*background: var\(--app-surface-alt\)/);
  assert.match(styles, /\.coding-architecture-plan-card \{[^}]*background: var\(--app-panel\)/);
  assert.match(styles, /\.coding-architecture-plan-actions > button:focus-visible[^}]*outline: 2px solid var\(--app-accent\)/);
  assert.match(styles, /\.coding-architecture-plan-actions > button:disabled \{[^}]*cursor: not-allowed/);
  assert.match(styles, /@media \(max-width: 640px\) \{ \.coding-architecture-plans[^\n]*\.coding-architecture-plan-actions > button \{ width: 100%; \}/);
});

test("modal approvals call exact revision action API with no hidden chat command", async () => {
  const modal = await readFile(new URL("../components/plan-review-modal.jsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../lib/node-client.js", import.meta.url), "utf8");
  assert.match(modal, /client.handoffPlan\(projectId, plan, token\)/);
  assert.match(modal, /current.status === "superseded"/);
  assert.match(modal, /submitting.current/);
  assert.doesNotMatch(modal, /postOwnerMessage|text: `\/approve|Open the Architecture conversation/);
  assert.match(client, /plan.revision\}\/handoff/);
  assert.match(client, /sha256: plan.sha256/);
});
