// Verifies stale Sprint drafting workflows preserve the winner and retain immutable revision/approval evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createSprintPlanDraftPersistence } from "../../src/modules/governance/sprint-plan-draft-persistence.js";

const SPRINT = { id: "SPRINT-A", project_id: "PROJECT-A", objective: "Ship API", tickets: [{ id: "TICKET-API-1", title: "Fix API", objective: "Fix API", implementation_type: ["backend"], file_budget: 4, acceptance_criteria: ["Pass"] }], human_plan: { outcome: "Working API", in_scope: "API", out_of_scope: "UI", approach: "Update API", components: ["API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Summary"], acceptance_criteria: ["Pass"] } };
const MARKDOWN = "# Plan: API\n\n## 1. Scope\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Fix API | backend | Fix API | — | ≤ 4 files | Pass |\n\n## 6. Risks\n\nNone\n\n## 7. Acceptance";

// Creates actual immutable stores and an optional unbound scheduling record in disposable SQLite.
async function fixture({ registered = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-draft-race-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**"] });
  const markdownPlans = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService, markdownPlans });
  const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
  if (registered) await registry.register({ sprintId: "SPRINT-A", position: 0 });
  const createDraft = (planStore = plans) => createSprintPlanDraftPersistence({ projectId: "PROJECT-A", planStore, markdownPlanStore: markdownPlans, sprintRegistry: registry });
  return { root, database, fileService, markdownPlans, plans, registry, createDraft, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Pauses after committed immutable evidence so an independent drafting workflow can win the bind.
function pauseStore(plans, method) {
  let enter;
  let release;
  let artifact;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const store = { ...plans, [method]: async (input) => { artifact = await plans[method](input); enter(); await gate; return artifact; } };
  return { entered, release, store, artifact: () => artifact };
}

test("workflow observing version zero cannot overwrite a later workflow's binding", async () => {
  const f = await fixture();
  const paused = pauseStore(f.plans, "createRevision");
  try {
    const losing = f.createDraft(paused.store)(SPRINT);
    await paused.entered;
    const winner = await f.createDraft()(SPRINT);
    const scheduling = f.registry.get("SPRINT-A");
    assert.equal(winner.revision, 2);
    paused.release();
    await assert.rejects(losing, (error) => {
      assert.equal(error.code, "SPRINT_REGISTRY_CONFLICT");
      assert.equal(error.recovery.observed_version, 0);
      assert.equal(error.recovery.disposition, "retained_immutable_revision");
      assert.equal(error.recovery.revision, 1);
      assert.equal(error.recovery.sha256, paused.artifact().sha256);
      return true;
    });
    assert.deepEqual(f.registry.get("SPRINT-A"), scheduling);
    assert.equal((await f.plans.getRevision({ planId: winner.plan_id, revision: 1 })).sha256, paused.artifact().sha256);
    assert.equal(f.database.all("SELECT COUNT(*) AS count FROM plan_revisions")[0].count, 2);
  } finally { paused.release(); await f.close(); }
});

test("approved immutable evidence survives a stale bind and exact-parent recovery does not reset readiness", async () => {
  const f = await fixture();
  const paused = pauseStore(f.plans, "approveDerived");
  try {
    const summary = "# Scope\n";
    const summaryPath = ".forge/runtime/nf/summary/SUMMARY-A.md";
    await f.fileService.atomicWrite({ path: summaryPath, content: summary, replace: true });
    const parent = await f.markdownPlans.createRevision({ planId: "PLAN-PARENT", markdown: MARKDOWN, summaryPath, summarySha256: createHash("sha256").update(summary).digest("hex") });
    await f.markdownPlans.decide({ planId: parent.plan_id, revision: parent.revision, sha256: parent.sha256, decision: "approved", approverId: "OWNER", comments: null });
    const trace = { approvedParentPlanKey: `${parent.plan_id}-R${parent.revision}-${parent.sha256}` };
    const losing = f.createDraft(paused.store)(SPRINT, trace);
    await paused.entered;
    const winner = await f.createDraft()(SPRINT, trace);
    await f.registry.setStatus({ sprintId: "SPRINT-A", status: "ready" });
    const scheduling = f.registry.get("SPRINT-A");
    paused.release();
    await assert.rejects(losing, { code: "SPRINT_REGISTRY_CONFLICT" });
    assert.deepEqual(f.registry.get("SPRINT-A"), scheduling);
    assert.equal((await f.plans.assertExecutable({ planId: winner.plan_id, revision: winner.revision, sha256: winner.sha256 })).approval_basis, "approved_markdown_projection");
    assert.equal(f.database.all("SELECT COUNT(*) AS count FROM derived_plan_approvals")[0].count, 1);
    const recovered = await f.createDraft()(SPRINT, trace);
    assert.equal(recovered.sha256, winner.sha256);
    assert.deepEqual(f.registry.get("SPRINT-A"), scheduling);
  } finally { paused.release(); await f.close(); }
});

test("initial registration race retains the losing immutable revision without deleting the winner", async () => {
  const f = await fixture({ registered: false });
  const paused = pauseStore(f.plans, "createRevision");
  try {
    const losing = f.createDraft(paused.store)(SPRINT);
    await paused.entered;
    const winner = await f.createDraft()(SPRINT);
    const scheduling = f.registry.get("SPRINT-A");
    paused.release();
    await assert.rejects(losing, (error) => { assert.equal(error.code, "SPRINT_REGISTRY_EXISTS"); assert.equal(error.recovery.requires_reconciliation, true); return true; });
    assert.deepEqual(f.registry.get("SPRINT-A"), scheduling);
    assert.equal((await f.plans.getRevision({ planId: winner.plan_id, revision: 1 })).sha256, paused.artifact().sha256);
  } finally { paused.release(); await f.close(); }
});
