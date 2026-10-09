// Verifies public Sprint CRUD uses immutable Registry scope, preserves archived history and fences stale mutations.
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { once } from "node:events";
import { sprintMigrationFixture, PROJECT, SPRINT } from "../fixtures/sprint-registry-migration-fixture.mjs";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { createNodeClient } from "../../../ui/nextjs/lib/node-client.js";

// Connects real SQLite and immutable plan files to the public route, making every legacy mutation a test failure.
async function fixture(t) {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const plans = createHumanPlanStore({ projectId: PROJECT, database: f.database, fileService: createFileService({ projectRoot: f.config.cwd, allowPlanStorage: true }) });
  const registry = createSprintRegistry({ projectId: PROJECT, database: f.database, plans });
  const dashboard = createProjectDashboardService({ roadmaps: f.roadmaps, sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => null, getSprintBacklog: () => [] }, sprintRegistry: registry, ticketFileStore: f.tickets });
  const router = createForgeV1Router({ expectedProjectId: PROJECT, planStore: plans, sprintRegistry: registry, projectDashboardService: dashboard,
    sprintPlanUploadService: { list: ({ projectId }) => projectId === PROJECT ? f.roadmaps.getCurrent().sprints : [], upload: () => assert.fail("Legacy create must not run"), update: () => assert.fail("Legacy update must not run"), remove: () => assert.fail("Legacy delete must not run"), get: () => assert.fail("Legacy detail must not run") }
  });
  return { ...f, plans, registry, router };
}

// Invokes the actual router with HTTP-shaped body and project context rather than a CRUD service double.
function request(f, method, path, body, project = PROJECT) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []); req.headers = {};
  return f.router.route(method, new URL(`http://localhost/forge/v1/${path}${path.includes("?") ? "&" : "?"}project=${project}`), req);
}

// Creates canonical Sprint scope using the same payload expected by the upload client.
async function create(f, sprint = SPRINT) {
  return request(f, "POST", "sprints", { project_id: PROJECT, sprint_plan: structuredClone(sprint) });
}

test("POST/GET/PUT/DELETE operate on Registry and immutable revisions, not legacy Roadmap", async (t) => {
  const f = await fixture(t);
  const originalRoadmap = f.roadmaps.getCurrent();
  const created = await create(f);
  assert.equal(created.status, 201);
  assert.equal(created.body.sprint_plan.version, 0);
  assert.equal(created.body.sprint_plan.status, "awaiting_human_approval");
  assert.equal((await request(f, "GET", `sprints/${SPRINT.id}`)).body.id, SPRINT.id);
  assert.equal((await request(f, "GET", "sprints")).body.length, 1);
  const initial = f.registry.get(SPRINT.id);
  const oldPlan = await f.plans.getRevision({ planId: initial.plan_id, revision: 1 });
  const update = structuredClone(SPRINT); update.objective = "Revised objective";
  const revised = await request(f, "PUT", `sprints/${SPRINT.id}`, { project_id: PROJECT, expected_version: 0, sprint_plan: update });
  assert.equal(revised.body.sprint_plan.plan_revision, 2);
  assert.equal(revised.body.sprint_plan.version, 1);
  assert.equal(revised.body.sprint_plan.status, "awaiting_human_approval");
  assert.equal((await f.plans.getRevision({ planId: initial.plan_id, revision: 1 })).sha256, oldPlan.sha256);
  assert.equal((await request(f, "GET", `projects/${PROJECT}/dashboard`)).body.roadmap.sprints[0].objective, "Revised objective");
  const removed = await request(f, "DELETE", `sprints/${SPRINT.id}?expected_version=1`);
  assert.equal(removed.body.archived, true);
  assert.equal(f.registry.list().length, 0);
  assert.equal(f.registry.list({ includeArchived: true }).length, 1);
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 2);
  assert.deepEqual(f.roadmaps.getCurrent(), originalRoadmap);
  assert.deepEqual((await request(f, "GET", "sprints")).body, []);
  assert.equal((await request(f, "GET", `projects/${PROJECT}/dashboard`)).body.roadmap, null);
  await assert.rejects(request(f, "GET", `sprints/${SPRINT.id}`), { code: "SPRINT_NOT_FOUND", statusCode: 404 });
  await assert.rejects(create(f), { code: "SPRINT_REGISTRY_EXISTS" });
});

test("wrong project, missing scope, stale versions and dependency rewrites do not mutate Registry", async (t) => {
  const f = await fixture(t);
  await assert.rejects(request(f, "POST", "sprints", { project_id: "PROJECT-OTHER", sprint_plan: SPRINT }, "PROJECT-OTHER"), { code: "PROJECT_CONTEXT_CONFLICT" });
  const incomplete = structuredClone(SPRINT); delete incomplete.human_plan;
  await assert.rejects(create(f, incomplete), { code: "PLAN_DRAFT_INCOMPLETE" });
  assert.equal(f.plans.list().length, 0);
  await create(f);
  await assert.rejects(request(f, "PUT", `sprints/${SPRINT.id}`, { project_id: PROJECT, sprint_plan: SPRINT }), { code: "SPRINT_REGISTRY_CONFLICT" });
  await assert.rejects(request(f, "DELETE", `sprints/${SPRINT.id}`), { code: "SPRINT_REGISTRY_CONFLICT" });
  await assert.rejects(request(f, "DELETE", `sprints/${SPRINT.id}?expected_version=99`), { code: "SPRINT_REGISTRY_CONFLICT" });
  await assert.rejects(request(f, "PUT", `sprints/${SPRINT.id}`, { project_id: PROJECT, expected_version: 0, sprint_plan: { ...SPRINT, dependencies: ["SPRINT-MISSING"] } }), { code: "SPRINT_DEPENDENCY_CONFLICT" });
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 1);
});

test("old approval cannot authorize the replacement immutable revision", async (t) => {
  const f = await fixture(t); await create(f);
  const record = f.registry.get(SPRINT.id);
  await f.plans.decide({ planId: record.plan_id, revision: 1, sha256: record.plan_sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
  const updated = await request(f, "PUT", `sprints/${SPRINT.id}`, { project_id: PROJECT, expected_version: 0, sprint_plan: { ...SPRINT, objective: "New approval required" } });
  assert.equal(updated.body.plan.status, "awaiting_human_approval");
  await assert.rejects(f.registry.setStatus({ sprintId: SPRINT.id, status: "ready", expectedVersion: 1 }), { code: "PLAN_APPROVAL_REQUIRED" });
  assert.equal(f.database.all("SELECT * FROM plan_decisions").length, 1);
});

test("retained Ticket execution and dependent Sprints block archive", async (t) => {
  const f = await fixture(t); await create(f);
  const record = f.registry.get(SPRINT.id);
  f.statuses.create("TICKET-MIGRATION", { execution_id: "EXEC-RETAINED", execution_basis: record });
  await assert.rejects(request(f, "DELETE", `sprints/${SPRINT.id}?expected_version=0`), { code: "SPRINT_EXECUTION_RECONCILIATION_REQUIRED" });
  await assert.rejects(request(f, "PUT", `sprints/${SPRINT.id}`, { project_id: PROJECT, expected_version: 0, sprint_plan: SPRINT }), { code: "SPRINT_EXECUTION_RECONCILIATION_REQUIRED" });
  assert.equal(f.plans.list()[0].revision, 1);
});

test("archive cannot orphan Sprint dependencies and reserves historical positions", async (t) => {
  const f = await fixture(t); await create(f);
  const next = { ...structuredClone(SPRINT), id: "SPRINT-NEXT", dependencies: [SPRINT.id], tickets: [{ ...SPRINT.tickets[0], id: "TICKET-NEXT", sprint_id: "SPRINT-NEXT" }] };
  await create(f, next);
  await assert.rejects(request(f, "DELETE", `sprints/${SPRINT.id}?expected_version=0`), { code: "SPRINT_DEPENDENCY_IN_USE" });
  await request(f, "DELETE", "sprints/SPRINT-NEXT?expected_version=0");
  await request(f, "DELETE", `sprints/${SPRINT.id}?expected_version=0`);
  const third = { ...next, id: "SPRINT-THIRD", dependencies: [], tickets: [{ ...next.tickets[0], id: "TICKET-THIRD", sprint_id: "SPRINT-THIRD" }] };
  await create(f, third);
  assert.equal(f.registry.get("SPRINT-THIRD").position, 2);
});

test("archive winning the race blocks a stale execution claim at its transactional write", async (t) => {
  const f = await fixture(t); await create(f);
  const basis = f.registry.get(SPRINT.id);
  f.statuses.create("TICKET-MIGRATION");
  await request(f, "DELETE", `sprints/${SPRINT.id}?expected_version=0`);
  assert.throws(() => f.statuses.beginExecution("TICKET-MIGRATION", { executionId: "EXEC-STALE", basis, expectedVersion: 0 }), { code: "SPRINT_ARCHIVED" });
  assert.equal(f.statuses.get("TICKET-MIGRATION").status, "pending");
});

test("actual UI client archives a Registry-only Sprint through HTTP with expected version", async (t) => {
  const f = await fixture(t);
  const previous = process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL;
  const server = createHttpApi({ forgeV1Router: f.router }).createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = `http://127.0.0.1:${server.address().port}`;
    const client = createNodeClient();
    await client.uploadSprintPlan(PROJECT, SPRINT);
    const detail = await client.getSprintPlan(PROJECT, SPRINT.id);
    const revised = await client.updateSprintPlan(PROJECT, SPRINT.id, { ...detail, objective: "Client-revised scope" });
    assert.equal(revised.sprint_plan.plan_revision, 2);
    const result = await client.deleteSprintPlan(PROJECT, SPRINT.id);
    assert.equal(result.archived, true);
    assert.deepEqual(await client.listSprints(PROJECT), []);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL; else process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL = previous;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
