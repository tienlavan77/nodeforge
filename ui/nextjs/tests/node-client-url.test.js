// Verifies project-scoped client URLs use path identity without breaking query-scoped API endpoints.
import assert from "node:assert/strict";
import test from "node:test";
import { forgeV1, controlApiBase } from "../lib/node-client-url.js";
import { createNodeClient } from "../lib/node-client.js";
import { createForgeV1Router } from "../../../backend/src/transport/http/forge-v1-router.js";

// Project path identity removes only its duplicate selector, preserving history filters and encoded values.
test("project-scoped URLs omit redundant project query while preserving filters", () => {
  const url = new URL(forgeV1("/projects/PROJECT-NODEFORGE/dashboard", { project: "PROJECT-NODEFORGE" }));
  assert.equal(url.pathname, "/forge/v1/projects/PROJECT-NODEFORGE/dashboard");
  assert.equal(url.search, "");
  const history = new URL(forgeV1("/projects/PROJECT-A/history", { project: "PROJECT-A", agent: "coder", limit: 0, enabled: false, cursor: "a b", missing: undefined }));
  assert.deepEqual(Object.fromEntries(history.searchParams), { agent: "coder", limit: "0", enabled: "false", cursor: "a b" });
  assert.equal(new URL(forgeV1("/projects/PROJECT%20A/dashboard", { project: "PROJECT A" })).search, "");
});

// Routes without a project path still require their query context; a different identity must not be silently erased.
test("unscoped and mismatched project queries are preserved", () => {
  for (const path of ["/tickets/TICKET-A", "/sprints", "/plans", "/git/status", "/conversations", "/projects-archive/PROJECT-A"]) {
    assert.equal(new URL(forgeV1(path, { project: "PROJECT-A" })).searchParams.get("project"), "PROJECT-A");
  }
  assert.equal(new URL(forgeV1("/projects/PROJECT-A/dashboard", { project: "PROJECT-B" })).searchParams.get("project"), "PROJECT-B");
});

// Origin extraction preserves existing deployment configuration and trailing-slash behavior.
test("control API origin configuration remains unchanged", (t) => {
  const previous = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  t.after(() => { if (previous === undefined) delete process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL; else process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = previous; });
  process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = "http://node.test:3100/";
  assert.equal(controlApiBase(), "http://node.test:3100");
  assert.equal(forgeV1("/projects/PROJECT-A/dashboard", { project: "PROJECT-A" }), "http://node.test:3100/forge/v1/projects/PROJECT-A/dashboard");
});

// Exercises the actual UI client against the backend router so dashboard path identity is sufficient end-to-end.
test("dashboard client reaches Forge router without project query and legacy duplicate remains accepted", async (t) => {
  const calls = [];
  const router = createForgeV1Router({ projectDashboardService: { getDashboard: async (projectId) => ({ project_id: projectId, backlog: [] }) } });
  t.mock.method(globalThis, "fetch", async (address, init = {}) => {
    const url = new URL(address); calls.push(url);
    const result = await router.route(init.method ?? "GET", url, { headers: {} });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  });
  const dashboard = await createNodeClient().getProjectDashboard("PROJECT-NODEFORGE");
  assert.equal(dashboard.project_id, "PROJECT-NODEFORGE");
  assert.equal(calls[0].pathname, "/forge/v1/projects/PROJECT-NODEFORGE/dashboard");
  assert.equal(calls[0].search, "");
  const legacy = await router.route("GET", new URL("http://node.test/forge/v1/projects/PROJECT-NODEFORGE/dashboard?project=PROJECT-NODEFORGE"), { headers: {} });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.project_id, dashboard.project_id);
});

// Shared URL construction cleans project history/decisions while leaving ticket/sprint lookups scoped by query.
test("actual client preserves query scoping and removes duplicate history project selector", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (address) => { calls.push(new URL(address)); return new Response("{}", { status: 200 }); });
  const client = createNodeClient();
  await client.getConversationAuditHistory({ projectId: "PROJECT-A", agentId: "coder", limit: 20 });
  assert.equal(calls[0].searchParams.has("project"), false);
  assert.equal(calls[0].searchParams.get("agent"), "coder");
  await client.getTicket("PROJECT-A", "TICKET-A");
  assert.equal(calls[1].searchParams.get("project"), "PROJECT-A");
  await client.listSprints("PROJECT-A");
  assert.equal(calls[2].searchParams.get("project"), "PROJECT-A");
});
