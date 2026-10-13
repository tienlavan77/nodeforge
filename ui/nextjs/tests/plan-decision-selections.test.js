// Verifies explicit policy selection and isolation across multiple Sprint Plan review revisions.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { planDecisionSelectionKey, planDecisionSelectionsComplete } from "../lib/plan-decision-selections.js";
import { createCodingPlanLoader, reviewableArchitecturePlans } from "../lib/coding-plan-loader.js";

const request = { id: "STORAGE", options: [{ id: "LOCAL" }], recommended_option_id: "LOCAL" };

test("recommendation never preselects approval and incomplete/unsupported options remain blocked", () => {
  assert.equal(planDecisionSelectionsComplete([request], {}), false);
  assert.equal(planDecisionSelectionsComplete([request], { STORAGE: "UNKNOWN" }), false);
  assert.equal(planDecisionSelectionsComplete([request], { STORAGE: "LOCAL" }), true);
  assert.equal(planDecisionSelectionsComplete([{ ...request, options: [] }], {}), false);
});

test("choice identity separates project, plan, revision and checksum", () => {
  const plan = { project_id: "PROJECT-A", plan_id: "PLAN-A", revision: 1, sha256: "a".repeat(64) };
  for (const patch of [{ project_id: "PROJECT-B" }, { plan_id: "PLAN-B" }, { revision: 2 }, { sha256: "b".repeat(64) }]) assert.notEqual(planDecisionSelectionKey(plan), planDecisionSelectionKey({ ...plan, ...patch }));
});

test("multiple pending Sprint Plans appear alongside Architecture instead of hiding child decisions", async () => {
  const plans = ["PLAN-A", "PLAN-B"].map((id) => ({ plan_id: id, sprint_id: `SPRINT-${id}`, revision: 1, sha256: "a".repeat(64), status: "awaiting_human_approval", created_at: id, decision_requests: [request] }));
  assert.equal(reviewableArchitecturePlans(plans).length, 2);
  const states = [];
  const loader = createCodingPlanLoader({ projectId: "PROJECT-A", client: { listPlans: async () => plans, getPlanRevision: async (_project, id) => plans.find((plan) => plan.plan_id === id) }, onState: (state) => states.push(state) });
  await loader.load();
  assert.equal(states[0].plans.length, 2);
});

test("review displays tradeoffs, selections and disabled approval; Sprint cards expose per-plan review", async () => {
  const component = await readFile(new URL("../components/plan-decision-requests.jsx", import.meta.url), "utf8");
  const modal = await readFile(new URL("../components/plan-review-modal.jsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../components/sprint-plan-panels.jsx", import.meta.url), "utf8");
  assert.match(component, /option\.description/);
  assert.match(component, /request\.recommended_option_id/);
  assert.match(component, /checked=\{selections\[request.id\] === option.id\}/);
  assert.match(component, /decision-\$\{scope\}-\$\{request.id\}/);
  assert.match(modal, /disabled=\{!token \|\| state === "submitting" \|\| !choicesComplete\}/);
  assert.match(modal, /client\.decidePlan\(projectId, plan, decision, token, comments, decisionIds\.current\.get\(key\), selections\)/);
  assert.match(modal, /scheduled\.plan_id !== plan\.plan_id/);
  assert.match(dashboard, /Review &amp; approve|Review & approve/);
});
