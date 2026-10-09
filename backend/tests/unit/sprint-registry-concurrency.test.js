// Verifies version-fenced Sprint scheduling survives races without overwriting newer status or plan bindings.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { routePlan } from "../../src/transport/http/forge-v1-plan-routes.js";

const CONTENT = { objective: "Scheduling races", outcome: "Preserve current basis", in_scope: "Registry", out_of_scope: "RUN dispatch", approach: "Fence writes", components: ["Registry"], tickets: ["TICKET-A"], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: ["TICKET-A"], acceptance_criteria: ["Stale writes fail"] };

// Uses real SQLite and immutable approval storage with a fixed clock to exercise ABA safety.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sprint-concurrency-"));
  const options = { dataDir: join(root, ".forge/runtime"), runtimeDir: "." };
  const database = await createDatabaseService(options);
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
  const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
  const clock = () => "2026-10-08T00:00:00.000Z";
  const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans, clock });
  const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content: CONTENT });
  await plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
  await registry.register({ sprintId: "SPRINT-A", position: 0, planId: plan.plan_id, revision: 1 });
  return { root, options, database, plans, registry, clock, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Pauses after a genuine immutable read so another connection can mutate scheduling before commit.
function pauseValidation(f, method) {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const plans = { ...f.plans, [method]: async (input) => { const result = await f.plans[method](input); enter(); await gate; return result; } };
  return { entered, release, registry: createSprintRegistry({ projectId: "PROJECT-A", database: f.database, plans, clock: f.clock }) };
}

test("delayed readiness cannot authorize a newer unapproved binding", async () => {
  const f = await fixture();
  const paused = pauseValidation(f, "assertExecutable");
  try {
    const pending = paused.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
    await paused.entered;
    const revised = await f.plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 1, content: { ...CONTENT, approach: "Revised basis" } });
    const winner = await f.registry.bindPlan({ sprintId: "SPRINT-A", planId: revised.plan_id, revision: revised.revision });
    paused.release();
    await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT", statusCode: 409, retryable: false });
    assert.deepEqual(f.registry.get("SPRINT-A"), winner);
    assert.equal(winner.plan_revision, 2);
    assert.equal(winner.status, "awaiting_human_approval");
  } finally { paused.release(); await f.close(); }
});

test("delayed rebind cannot reset a Sprint that started running on another connection", async () => {
  const f = await fixture();
  const paused = pauseValidation(f, "getRevision");
  const otherDatabase = await createDatabaseService(f.options);
  try {
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
    const pending = paused.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
    await paused.entered;
    const otherPlans = createHumanPlanStore({ projectId: "PROJECT-A", database: otherDatabase, fileService: createFileService({ projectRoot: f.root, allowPlanStorage: true }) });
    const otherRegistry = createSprintRegistry({ projectId: "PROJECT-A", database: otherDatabase, plans: otherPlans, clock: f.clock });
    const winner = await otherRegistry.setStatus({ sprintId: "SPRINT-A", status: "running" });
    paused.release();
    await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT" });
    assert.deepEqual(f.registry.get("SPRINT-A"), winner);
    assert.equal(winner.status, "running");
  } finally { paused.release(); await otherDatabase.close(); await f.close(); }
});

test("delayed completion cannot overwrite a newer blocked status", async () => {
  const f = await fixture();
  const paused = pauseValidation(f, "assertExecutable");
  try {
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "running" });
    const pending = paused.registry.setStatus({ sprintId: "SPRINT-A", status: "done" });
    await paused.entered;
    const winner = await f.registry.setStatus({ sprintId: "SPRINT-A", status: "blocked" });
    paused.release();
    await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT" });
    assert.deepEqual(f.registry.get("SPRINT-A"), winner);
  } finally { paused.release(); await f.close(); }
});

test("same-basis same-clock intervening writes still invalidate stale bind and caller expectations", async () => {
  const f = await fixture();
  const paused = pauseValidation(f, "getRevision");
  try {
    const original = f.registry.get("SPRINT-A");
    const pending = paused.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
    await paused.entered;
    await f.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
    const winner = await f.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
    paused.release();
    await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT" });
    assert.equal(winner.updated_at, original.updated_at);
    assert.equal(winner.version, original.version + 2);
    for (const expectedVersion of [original.version, -1, "2"]) {
      await assert.rejects(f.registry.setStatus({ sprintId: "SPRINT-A", status: "blocked", expectedVersion }), { code: "SPRINT_REGISTRY_CONFLICT" });
      await assert.rejects(f.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1, expectedVersion }), { code: "SPRINT_REGISTRY_CONFLICT" });
    }
    assert.deepEqual(f.registry.get("SPRINT-A"), winner);
  } finally { paused.release(); await f.close(); }
});

test("Registry routes preserve expected_version and reject obsolete requests without mutation", async () => {
  const f = await fixture();
  try {
    const context = { method: "PUT", projectId: "PROJECT-A", expectedProjectId: "PROJECT-A", sprintRegistry: f.registry };
    const result = await routePlan({ ...context, parts: ["sprints", "registry", "SPRINT-A", "status"], body: { status: "blocked", expected_version: 0 } });
    assert.equal(result.body.version, 1);
    for (const [operation, body] of [["status", { status: "blocked", expected_version: 0 }], ["plan", { plan_id: "PLAN-A", plan_revision: 1, expected_version: 0 }]]) {
      await assert.rejects(routePlan({ ...context, parts: ["sprints", "registry", "SPRINT-A", operation], body }), { code: "SPRINT_REGISTRY_CONFLICT", scope: "scoped", retryable: false });
      assert.deepEqual(f.registry.get("SPRINT-A"), result.body);
    }
    await assert.rejects(routePlan({ ...context, projectId: "PROJECT-B", parts: ["sprints", "registry", "SPRINT-A", "status"], body: { status: "blocked", expected_version: 1 } }), { code: "PROJECT_CONTEXT_CONFLICT" });
    assert.deepEqual(f.registry.get("SPRINT-A"), result.body);
  } finally { await f.close(); }
});

for (const mutation of ["block", "rebind", "same-basis-rebind"]) {
  test(`assertReady rejects a snapshot invalidated by ${mutation} during immutable validation`, async () => {
    const f = await fixture();
    const paused = pauseValidation(f, "assertExecutable");
    try {
      const ready = await f.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
      const pending = paused.registry.assertReady("SPRINT-A", { expectedVersion: ready.version });
      await paused.entered;
      if (mutation === "block") await f.registry.setStatus({ sprintId: "SPRINT-A", status: "blocked" });
      else if (mutation === "rebind") {
        const revised = await f.plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 1, content: { ...CONTENT, approach: "New readiness basis" } });
        await f.registry.bindPlan({ sprintId: "SPRINT-A", planId: revised.plan_id, revision: revised.revision });
      } else {
        await f.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
        await f.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
      }
      const winner = f.registry.get("SPRINT-A");
      paused.release();
      await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT", statusCode: 409, retryable: false });
      await assert.rejects(f.registry.assertReady("SPRINT-A", { expectedVersion: ready.version }), { code: "SPRINT_REGISTRY_CONFLICT" });
      assert.deepEqual(f.registry.get("SPRINT-A"), winner);
    } finally { paused.release(); await f.close(); }
  });
}

test("two binds observing the same version commit exactly one winner", async () => {
  const f = await fixture();
  const paused = pauseValidation(f, "getRevision");
  try {
    const first = paused.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
    const second = paused.registry.bindPlan({ sprintId: "SPRINT-A", planId: "PLAN-A", revision: 1 });
    await paused.entered;
    paused.release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");
    assert.equal(failed.reason.code, "SPRINT_REGISTRY_CONFLICT");
    assert.equal(f.registry.get("SPRINT-A").version, 1);
  } finally { paused.release(); await f.close(); }
});
