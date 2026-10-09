// Verifies Registry-owned Coding dashboards and scoped reconciliation diagnostics cross HTTP, client, and rendered UI.
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createNodeClient } from "../../../ui/nextjs/lib/node-client.js";
import { createCodingDashboardLoader } from "../../../ui/nextjs/lib/coding-dashboard-loader.js";
import { CodingSprintDashboardState } from "../../../ui/nextjs/components/coding-sprint-dashboard-state.js";

const require = createRequire(new URL("../../../ui/nextjs/package.json", import.meta.url));
const { createElement: h } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const PROJECT = "PROJECT-A";
const TICKET = { id: "TICKET-A", project_id: PROJECT, sprint_id: "SPRINT-A", title: "Immutable title", objective: "Show approved scope", dependencies: [], acceptance_criteria: ["No legacy overwrite"] };
const CONTENT = { objective: TICKET.objective, outcome: "Read authoritative scope", in_scope: "Dashboard", out_of_scope: "RUN", approach: "Registry projection", components: ["Dashboard"], tickets: [TICKET.id], ticket_specs: [TICKET], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: [TICKET.id], acceptance_criteria: TICKET.acceptance_criteria };

// Builds actual immutable Registry storage for project-isolated dashboard reads.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coding-registry-dashboard-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
  const plans = createHumanPlanStore({ projectId: PROJECT, database, fileService });
  const registry = createSprintRegistry({ projectId: PROJECT, database, plans });
  const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content: CONTENT });
  await registry.register({ sprintId: "SPRINT-A", position: 0, planId: plan.plan_id, revision: 1 });
  const state = { roadmap: { id: "ROADMAP-OLD", project_id: PROJECT, sprints: [] }, metadata: [] };
  const service = createProjectDashboardService({ sprintRegistry: registry, roadmaps: { getCurrent: () => state.roadmap }, sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => { throw new Error("Legacy status must not authorize Registry dashboard"); }, getSprintBacklog: () => { throw new Error("Legacy tickets must not authorize Registry dashboard"); } }, ticketFileStore: { listMetadata: () => state.metadata, readLatest: () => { throw new Error("Legacy ticket must not replace immutable specs"); } } });
  return { root, database, registry, plans, fileService, state, service, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Renders the same state gate mounted by CodingWorkspaceMonitor.
function render(state) { return renderToStaticMarkup(h(CodingSprintDashboardState, { state, onRetry: () => {} }, h("button", null, "RUN"))); }

test("Registry dashboard uses immutable specs and ignores same-ID legacy ticket edits", async () => {
  const f = await fixture();
  try {
    f.state.roadmap.sprints = [{ id: "SPRINT-A", objective: "Legacy objective", tickets: [{ ...TICKET, title: "Unapproved title" }] }];
    f.state.metadata = [{ id: TICKET.id, project_id: PROJECT, sprint_id: TICKET.sprint_id }];
    const dashboard = await f.service.getDashboard(PROJECT);
    assert.equal(dashboard.roadmap.id, null);
    assert.equal(dashboard.roadmap.sprints[0].objective, CONTENT.objective);
    assert.equal(dashboard.roadmap.sprints[0].tasks[0].title, TICKET.title);
    assert.equal(dashboard.roadmap.sprints[0].status, "awaiting_human_approval");
    assert.deepEqual(dashboard.roadmap.sprints[0].ticket_ids, [TICKET.id]);
    f.state.metadata.push({ id: "TICKET-EXTRA", project_id: PROJECT, sprint_id: TICKET.sprint_id });
    await assert.rejects(f.service.getDashboard(PROJECT), { code: "TICKET_PLAN_SCOPE", retryable: false });
  } finally { await f.close(); }
});

test("active Coding loader renders bounded safe migration IDs and requestId from actual HTTP/client", async () => {
  const f = await fixture();
  const previousBase = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  const states = [];
  let reads = 0;
  const router = createForgeV1Router({ projectDashboardService: { getDashboard: (projectId) => { reads += 1; return f.service.getDashboard(projectId); } } });
  const server = createHttpApi({ forgeV1Router: router }).createServer();
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = `http://127.0.0.1:${server.address().port}`;
    f.state.roadmap.sprints = [{ id: "SPRINT-A" }, ...Array.from({ length: 30 }, (_, index) => ({ id: `SPRINT-LEGACY-${index}` })), { id: "../../unsafe" }];
    const client = createNodeClient();
    const fetchOriginal = globalThis.fetch;
    const tracedClient = { getProjectDashboard: async (projectId) => {
      globalThis.fetch = (url, options = {}) => fetchOriginal(url, { ...options, headers: { ...options.headers, "x-request-id": "REQ-CODING" } });
      try { return await client.getProjectDashboard(projectId); } finally { globalThis.fetch = fetchOriginal; }
    } };
    const loader = createCodingDashboardLoader({ client: tracedClient, projectId: PROJECT, onState: (state) => states.push(state), logger: () => {} });
    await loader.load();
    const unavailable = states.at(-1);
    assert.equal(unavailable.status, "error");
    assert.equal(unavailable.error.code, "sprint_registry_migration_required");
    assert.equal(unavailable.error.requestId, "REQ-CODING");
    assert.equal(unavailable.error.identifiers.length, 25);
    const html = render(unavailable);
    assert.match(html, /role="alert"/);
    assert.match(html, /SPRINT-LEGACY-0/);
    assert.match(html, /REQ-CODING/);
    assert.match(html, /not a full inventory/);
    assert.match(html, /authorized operator/);
    assert.doesNotMatch(html, /\.\.\/|unsafe|Retry|<button|No sprints registered/);
    await loader.load();
    assert.equal(reads, 1, "stream refresh must not auto-retry a non-retryable read conflict");
    const other = await client.getProjectDashboard("PROJECT-B");
    assert.deepEqual(other, { project_id: "PROJECT-B", roadmap: null });
    f.state.roadmap.sprints = [{ id: "SPRINT-A" }];
    await loader.load({ manual: true });
    assert.equal(states.at(-1).status, "ready");
    assert.match(render(states.at(-1)), />RUN</);
  } finally {
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
    else process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = previousBase;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await f.close();
  }
});

test("empty Registry is not cutover proof when current Project still has legacy sprints", async () => {
  const f = await fixture();
  try {
    const registry = createSprintRegistry({ projectId: "PROJECT-B", database: f.database, plans: createHumanPlanStore({ projectId: "PROJECT-B", database: f.database, fileService: f.fileService }) });
    const service = createProjectDashboardService({ sprintRegistry: registry, roadmaps: { getCurrent: () => ({ project_id: "PROJECT-B", sprints: [{ id: "SPRINT-B" }] }) }, sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => null, getSprintBacklog: () => [] } });
    await assert.rejects(service.getDashboard("PROJECT-B"), { code: "SPRINT_REGISTRY_MIGRATION_REQUIRED" });
    assert.deepEqual(await service.getDashboard(PROJECT), { project_id: PROJECT, roadmap: null });
    await f.database.run("UPDATE sprint_registry SET plan_sha256=? WHERE project_id=?", ["0".repeat(64), PROJECT]);
    assert.deepEqual(await f.service.getDashboard("PROJECT-B"), { project_id: "PROJECT-B", roadmap: null });
  } finally { await f.close(); }
});

test("Coding state distinguishes loading, empty, retryable outage and conflict without IDs", async () => {
  assert.match(render({ status: "loading" }), /Loading Sprint Plan/);
  assert.match(render({ status: "ready", dashboard: { project_id: PROJECT, roadmap: null } }), /No sprints registered/);
  const error = { code: "SPRINT_REGISTRY_MIGRATION_REQUIRED", retryable: false, scope: "scoped", message: "Reconcile scope", identifiers: ["../../unsafe"] };
  assert.match(render({ status: "error", error }), /authorized operator/);
  assert.doesNotMatch(render({ status: "error", error }), /Retry|unsafe|No sprints registered|<button/);
  assert.match(render({ status: "error", error: { code: "timeout", retryable: true, message: "Unavailable" } }), /Retry dashboard load/);
});

test("Coding loader ignores stale reads and prevents cross-project response disclosure", async () => {
  let release;
  let count = 0;
  const states = [];
  const loader = createCodingDashboardLoader({ projectId: PROJECT, onState: (state) => states.push(state), logger: () => {}, client: { getProjectDashboard: () => ++count === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ project_id: PROJECT, roadmap: null }) } });
  const old = loader.load();
  await loader.load();
  release({ project_id: PROJECT, roadmap: { sprints: [{ id: "STALE" }] } });
  await old;
  assert.equal(states.at(-1).dashboard.roadmap, null);
  const foreign = createCodingDashboardLoader({ projectId: PROJECT, onState: (state) => states.push(state), logger: () => {}, client: { getProjectDashboard: async () => ({ project_id: "PROJECT-B", roadmap: { sprints: [{ id: "SECRET" }] } }) } });
  await foreign.load();
  assert.equal(states.at(-1).status, "error");
  assert.equal(states.at(-1).dashboard, null);
  assert.doesNotMatch(render(states.at(-1)), /SECRET/);
});
