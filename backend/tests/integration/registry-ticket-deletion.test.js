// Verifies Registry ticket deletion works through public HTTP without legacy lookup or immutable-history loss.
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { once } from "node:events";
import { sprintMigrationFixture, PROJECT, SPRINT } from "../fixtures/sprint-registry-migration-fixture.mjs";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createRegistrySprintCrudService } from "../../src/application/registry-sprint-crud-service.js";
import { createSprintPlanUploadService } from "../../src/application/sprint-plan-upload-service.js";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createNodeClient } from "../../../ui/nextjs/lib/node-client.js";

const TARGET = SPRINT.tickets[0].id;

// Seeds Registry scope and turns every legacy deletion lookup into a failure.
async function fixture(t, { single = false, dependent = false } = {}) {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const plans = createHumanPlanStore({ projectId: PROJECT, database: f.database, fileService: createFileService({ projectRoot: f.config.cwd, allowPlanStorage: true }) });
  const registry = createSprintRegistry({ projectId: PROJECT, database: f.database, plans });
  const crud = createRegistrySprintCrudService({ projectId: PROJECT, registry, plans });
  const sprint = structuredClone(SPRINT);
  if (!single) sprint.tickets.push({ ...structuredClone(sprint.tickets[0]), id: "TICKET-KEEP", dependencies: dependent ? [TARGET] : [] });
  await crud.create({ sprintPlan: sprint });
  const events = [];
  const upload = createSprintPlanUploadService({ roadmaps: { save: () => assert.fail("legacy save"), getCurrent: () => assert.fail("legacy ticket lookup") },
    publisher: { publish: (event) => events.push({ ...event, event_type: event.type, source: event.metadata.source }) } });
  const dashboard = createProjectDashboardService({ roadmaps: f.roadmaps,
    sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => null, getSprintBacklog: () => [] },
    sprintRegistry: registry, ticketFileStore: f.tickets, eventStore: { getByType: () => events } });
  const router = createForgeV1Router({ expectedProjectId: PROJECT, sprintRegistry: registry, planStore: plans, sprintPlanUploadService: upload, projectDashboardService: dashboard });
  return { ...f, plans, registry, crud, router, events, dashboard };
}

// Exercises the production router with the project-scoped Delete request used by UI clients.
function request(f, path, project = PROJECT) {
  const req = Readable.from([]); req.headers = {};
  return f.router.route("DELETE", new URL(`http://localhost/forge/v1/${path}?project=${project}`), req);
}

test("Registry-only deletion revises scope, preserves old approval/history, and removes dashboard visibility", async (t) => {
  const f = await fixture(t);
  const before = f.registry.get(SPRINT.id);
  const old = await f.plans.getRevision({ planId: before.plan_id, revision: 1 });
  await f.plans.decide({ planId: before.plan_id, revision: 1, sha256: old.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
  const result = await request(f, `tickets/${TARGET}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted, true);
  assert.equal(result.body.plan_revision, 2);
  assert.equal(result.body.status, "awaiting_human_approval");
  assert.deepEqual((await f.registry.getDetail(SPRINT.id)).ticket_ids, ["TICKET-KEEP"]);
  assert.equal(await f.registry.getByTicket(TARGET), null);
  assert.equal((await f.plans.getRevision({ planId: before.plan_id, revision: 1 })).sha256, old.sha256);
  assert.equal(f.database.all("SELECT * FROM plan_decisions").length, 1);
  assert.equal(f.tickets.getMetadata(TARGET).id, TARGET);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event_type, "ticket.deleted");
  assert.equal(result.body.plan_sha256, f.registry.get(SPRINT.id).plan_sha256);
  for (const key of ["version", "status", "plan_id", "plan_revision", "plan_sha256"]) assert.equal(f.events[0].payload[key], result.body[key]);
  assert.deepEqual((await f.dashboard.getDashboard(PROJECT)).roadmap.sprints[0].tasks.map((ticket) => ticket.id), ["TICKET-KEEP"]);
  await assert.rejects(f.registry.setStatus({ sprintId: SPRINT.id, status: "ready", expectedVersion: 1 }), { code: "PLAN_APPROVAL_REQUIRED" });
  await assert.rejects(request(f, `tickets/${TARGET}`), { code: "TICKET_NOT_FOUND", statusCode: 404 });
});

test("project-scoped alias uses Registry and rejects wrong project or dangling dependencies", async (t) => {
  const f = await fixture(t);
  await assert.rejects(request(f, `tickets/${TARGET}`, "OTHER"), { code: "PROJECT_CONTEXT_CONFLICT" });
  await assert.rejects(request(f, `projects/OTHER/tickets/${TARGET}`), { code: "PROJECT_CONTEXT_CONFLICT" });
  assert.equal((await request(f, `projects/${PROJECT}/tickets/${TARGET}`)).body.deleted, true);
  const dependent = await fixture(t, { dependent: true });
  await assert.rejects(request(dependent, `tickets/${TARGET}`), { code: "TICKET_DEPENDENCY_CONFLICT" });
  assert.equal(dependent.plans.list()[0].revision, 1);
});

test("missing immutable store cannot fall back to legacy deletion", async (t) => {
  const f = await fixture(t);
  const router = createForgeV1Router({ expectedProjectId: PROJECT, sprintRegistry: f.registry,
    sprintPlanUploadService: createSprintPlanUploadService({ roadmaps: { save: () => assert.fail("legacy save"), getCurrent: () => assert.fail("legacy lookup") } }) });
  await assert.rejects(request({ router }, `tickets/${TARGET}`), { code: "SPRINT_REGISTRY_CONFIG", statusCode: 503 });
  assert.equal(f.registry.get(SPRINT.id).plan_revision, 1);
});

test("last ticket and retained execution ownership cannot be deleted", async (t) => {
  const single = await fixture(t, { single: true });
  await assert.rejects(request(single, `tickets/${TARGET}`), { code: "SPRINT_LAST_TICKET" });
  const active = await fixture(t);
  const basis = active.registry.get(SPRINT.id);
  active.statuses.create(TARGET, { execution_id: "EXEC-UNKNOWN", execution_basis: basis, launch_claim: { execution_id: "EXEC-UNKNOWN" } });
  await assert.rejects(request(active, `tickets/${TARGET}`), { code: "SPRINT_EXECUTION_RECONCILIATION_REQUIRED" });
  assert.equal(active.plans.list()[0].revision, 1);
  assert.equal(active.events.length, 0);
});

test("a concurrent Registry version change fences the bind and retains unbound revision evidence", async (t) => {
  const f = await fixture(t);
  const createRevision = f.plans.createRevision;
  const racingPlans = { ...f.plans, createRevision: async (input) => {
    const revision = await createRevision(input);
    await f.registry.setStatus({ sprintId: SPRINT.id, status: "blocked", expectedVersion: 0 });
    return revision;
  } };
  const router = createForgeV1Router({ expectedProjectId: PROJECT, sprintRegistry: f.registry, planStore: racingPlans,
    sprintPlanUploadService: createSprintPlanUploadService({ roadmaps: { save: () => assert.fail("legacy save") } }) });
  await assert.rejects(request({ router }, `tickets/${TARGET}`), (error) => error.code === "SPRINT_REGISTRY_CONFLICT" && error.recovery.revision === 2);
  assert.equal(f.registry.get(SPRINT.id).plan_revision, 1);
  assert.equal((await f.registry.getDetail(SPRINT.id)).tickets.length, 2);
});

test("existing UI Delete client works against the real Registry HTTP route", async (t) => {
  const f = await fixture(t);
  const previous = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  const server = createHttpApi({ forgeV1Router: f.router }).createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = `http://127.0.0.1:${server.address().port}`;
    const result = await createNodeClient().deleteTicket(PROJECT, TARGET);
    assert.equal(result.deleted, true);
    assert.equal(result.plan_revision, 2);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL; else process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = previous;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
