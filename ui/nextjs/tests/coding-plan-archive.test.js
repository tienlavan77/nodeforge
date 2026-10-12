// Verifies browser-local plan archiving keeps all actionable revisions reviewable without changing approval authority.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { codingArchitecturePlanList, codingPlanArchiveKey, codingPlanArchiveStorageKey, readCodingPlanArchives, setCodingPlanArchived } from "../lib/coding-plan-archive.js";

// Models project-specific browser persistence for Archive and Restore without server mutations.
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

// Supplies an immutable approval snapshot to test exact revision isolation.
function plan(planId, revision = 1, sha256 = "a".repeat(64)) {
  return Object.freeze({ plan_id: planId, revision, sha256, status: "approved", handoff_status: "failed" });
}

// Ensures the list preserves every actionable row and its loader ordering.
test("list shows all plans and Show archived reveals hidden rows", () => {
  const plans = [plan("NEW"), plan("OLD")];
  assert.deepEqual(codingArchitecturePlanList(plans, []), plans);
  const keys = [codingPlanArchiveKey(plans[0])];
  assert.deepEqual(codingArchitecturePlanList(plans, keys), [plans[1]]);
  assert.deepEqual(codingArchitecturePlanList(plans, keys, true), plans);
});

// Confirms archive persistence never changes approval or a different project or revision.
test("archive survives reread but is scoped to project, revision and checksum", () => {
  const storage = memoryStorage(); const original = plan("PLAN");
  const before = JSON.stringify(original);
  const keys = setCodingPlanArchived("PROJECT-A", original, true, storage);
  assert.deepEqual(readCodingPlanArchives("PROJECT-A", storage), keys);
  assert.deepEqual(readCodingPlanArchives("PROJECT-B", storage), []);
  assert.deepEqual(codingArchitecturePlanList([original], keys), []);
  const newer = plan("PLAN", 2); const changed = plan("PLAN", 1, "b".repeat(64));
  assert.deepEqual(codingArchitecturePlanList([newer, changed], keys), [newer, changed]);
  assert.equal(JSON.stringify(original), before);
  assert.doesNotMatch(storage.getItem(codingPlanArchiveStorageKey("PROJECT-A")), /approved|failed/);
});

// Retains archives saved by another tab and restores only the requested exact revision.
test("writes reread latest preferences and Restore retains other archived plans", () => {
  const storage = memoryStorage(); const first = plan("FIRST"); const second = plan("SECOND");
  setCodingPlanArchived("PROJECT", first, true, storage);
  setCodingPlanArchived("PROJECT", second, true, storage);
  assert.deepEqual(readCodingPlanArchives("PROJECT", storage), [codingPlanArchiveKey(first), codingPlanArchiveKey(second)]);
  setCodingPlanArchived("PROJECT", second, true, storage);
  const keys = setCodingPlanArchived("PROJECT", first, false, storage);
  assert.deepEqual(keys, [codingPlanArchiveKey(second)]);
  assert.deepEqual(codingArchitecturePlanList([first, second], keys), [first]);
});

// Rejects storage failures before the UI can hide a row without persisting the preference.
test("unavailable, malformed and quota-limited storage fail explicitly", () => {
  assert.throws(() => readCodingPlanArchives("PROJECT", null), /unavailable/);
  assert.throws(() => setCodingPlanArchived("PROJECT", plan("PLAN"), true, null), /unavailable/);
  const storage = memoryStorage(); const key = codingPlanArchiveStorageKey("PROJECT");
  for (const invalid of ["bad json", "{}", "[1]"]) {
    storage.setItem(key, invalid);
    assert.throws(() => readCodingPlanArchives("PROJECT", storage));
  }
  const quota = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.throws(() => setCodingPlanArchived("PROJECT", plan("PLAN"), true, quota), /quota/);
  assert.throws(() => codingPlanArchiveKey(plan("PLAN", 0)), /exact plan revision/);
  assert.throws(() => codingPlanArchiveStorageKey(""), /project is required/);
});

// Checks per-row handoff and adjacent Archive controls keep storage separate from approval APIs.
test("Coding renders list actions, Restore and project-scoped browser reconciliation", async () => {
  const component = await readFile(new URL("../components/coding-architecture-plans.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /<select|selectedId/);
  assert.match(component, /visiblePlans.map\(\(plan\)/);
  assert.match(component, /<li key=\{codingPlanArchiveKey\(plan\)\}/);
  assert.match(component, /onClick=\{\(\) => setReview\(plan\)\}/);
  assert.match(component, /Continue handoff[\s\S]*onClick=\{\(\) => handleArchive\(plan, !archived\)\}/);
  assert.match(component, /archived \? "Restore" : "Archive"/);
  assert.match(component, /aria-pressed=\{showArchived\}/);
  assert.match(component, /archives.projectId === projectId/);
  assert.match(component, /window.addEventListener\("storage", onStorage\)/);
  assert.match(component, /window.removeEventListener\("storage", onStorage\)/);
  const handler = component.slice(component.indexOf("function handleArchive"), component.indexOf("const stale"));
  assert.ok(handler.indexOf("setCodingPlanArchived(") < handler.indexOf("setArchives("));
  assert.match(handler, /catch \(error\)[\s\S]*console.error[\s\S]*setArchiveError/);
  assert.doesNotMatch(handler, /client\.|loader\.|handoffPlan|approvePlan/);
});
