// Business purpose: prevents the AM-SE approval control from routing an SE plan into Sprint Leader handoff.
// Technical description: exercises the rendered control with mocked React hooks and a project-scoped client, asserting exact plan identity and decision/resume ordering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";

const requireFromUi = createRequire(new URL("../package.json", import.meta.url));

// Business purpose: renders the actual handoff control and exposes its Owner token input and approval button.
// Technical description: bundles JSX for Node and replaces React hooks with stable state slots for click-driven tests.
async function mount(client, handoff) {
  const bundle = await build({ entryPoints: [new URL("../components/am-se-handoff-controls.jsx", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
  const state = [[handoff]];
  let cursor = 0;
  const react = { useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (next) => { state[index] = next; }]; }, useCallback(fn) { return fn; }, useEffect() {} };
  const jsx = { Fragment: Symbol.for("react.fragment"), jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)((name) => name === "react" ? react : name === "react/jsx-runtime" ? jsx : requireFromUi(name), module, module.exports);
  const render = () => { cursor = 0; return module.exports.AmSeHandoffControls({ client, projectId: "PROJECT-A", embedded: true }); };
  const find = (node, predicate) => { if (!node || typeof node !== "object") return null; if (Array.isArray(node)) return node.map((entry) => find(entry, predicate)).find(Boolean) ?? null; return predicate(node) ? node : find(node.props?.children, predicate); };
  const tokenInput = find(render(), (node) => node.type === "input");
  tokenInput.props.onChange({ target: { value: "owner-token" } });
  const button = find(render(), (node) => node.type === "button" && node.props.children === "Run");
  return { click: async () => { button.props.onClick(); await new Promise((resolve) => setImmediate(resolve)); }, alert: () => find(render(), (node) => node.props?.role === "alert")?.props.children };
}

const handoff = { handoff_id: "HANDOFF-PLAN-A-R1", plan_id: "PLAN-A", plan_revision: 2, plan_sha256: "a".repeat(64), approval_required: true, delivery_target: "se", roles: { am: { conversation_id: "CONV-A" } } };

test("AM-SE approval records the exact Owner decision and resumes SE without SL command", async () => {
  const calls = [];
  const client = {
    listHandoffs: async () => ({ items: [handoff] }),
    getPlanRevision: async () => ({ plan_id: "PLAN-A", revision: 2, sha256: handoff.plan_sha256, status: "awaiting_human_approval", format: "markdown" }),
    decidePlan: async (...args) => { calls.push(["decide", ...args]); },
    resumeHandoff: async (...args) => { calls.push(["resume", ...args]); },
    postOwnerMessage: async () => { throw new Error("SL /approve must not run"); }
  };
  const control = await mount(client, handoff);
  await control.click();
  assert.deepEqual(calls.map((call) => call[0]), ["decide", "resume"]);
  assert.deepEqual(calls[0].slice(1, 5), ["PROJECT-A", { plan_id: "PLAN-A", revision: 2, sha256: handoff.plan_sha256, status: "awaiting_human_approval", format: "markdown" }, "approved", "owner-token"]);
  assert.deepEqual(calls[1].slice(1), ["PROJECT-A", handoff, "owner-token"]);
});

test("AM-SE approval refuses stale revision/SHA without recording a decision or resuming", async () => {
  let invoked = false;
  const control = await mount({ listHandoffs: async () => ({ items: [handoff] }), getPlanRevision: async () => ({ plan_id: "PLAN-A", revision: 2, sha256: "b".repeat(64), status: "awaiting_human_approval" }), decidePlan: async () => { invoked = true; }, resumeHandoff: async () => { invoked = true; } }, handoff);
  await control.click();
  assert.equal(invoked, false);
  assert.match(control.alert(), /Plan changed/);
});

test("AM-SE approval resumes an already approved plan without a second decision", async () => {
  let decisions = 0;
  let resumes = 0;
  const control = await mount({ listHandoffs: async () => ({ items: [handoff] }), getPlanRevision: async () => ({ plan_id: "PLAN-A", revision: 2, sha256: handoff.plan_sha256, status: "approved" }), decidePlan: async () => { decisions++; }, resumeHandoff: async () => { resumes++; } }, handoff);
  await control.click();
  assert.equal(decisions, 0);
  assert.equal(resumes, 1);
});
