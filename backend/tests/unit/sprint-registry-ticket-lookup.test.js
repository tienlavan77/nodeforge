// Verifies ticket lookup skips unbound Sprints but rejects corrupt or foreign immutable bindings.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";

// Builds disposable SQLite and immutable files for project-isolated lookup regression tests.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sprint-lookup-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
  const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
  const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
  return { root, database, fileService, plans, registry, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Creates a valid immutable draft without manufacturing approval evidence.
async function bindDraft({ plans, registry }) {
  const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content: {
    objective: "Ticket lookup", outcome: "Find scoped tickets", in_scope: "Registry", out_of_scope: "RUN",
    approach: "Read immutable plan", components: ["Registry"], tickets: ["TICKET-A"], dependencies: [],
    risks: [], assumptions: [], open_questions: [], evidence_refs: ["TICKET-A"], acceptance_criteria: ["Lookup succeeds"]
  } });
  await registry.register({ sprintId: "SPRINT-A", position: 1, planId: plan.plan_id, revision: plan.revision });
  return plan;
}

test("empty and unbound Registry lookups return null; a later bound Sprint remains discoverable", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.registry.getByTicket("TICKET-A"), null);
    await f.registry.register({ sprintId: "SPRINT-UNBOUND", position: 0 });
    assert.equal(await f.registry.getByTicket("TICKET-A"), null);
    assert.deepEqual((await f.registry.getDetail("SPRINT-UNBOUND")).tickets, []);
    await bindDraft(f);
    assert.equal((await f.registry.getByTicket("TICKET-A")).sprint_id, "SPRINT-A");
    assert.equal(await f.registry.getByTicket("TICKET-MISSING"), null);
    const otherPlans = createHumanPlanStore({ projectId: "PROJECT-B", database: f.database, fileService: f.fileService });
    const otherRegistry = createSprintRegistry({ projectId: "PROJECT-B", database: f.database, plans: otherPlans });
    assert.equal(await otherRegistry.getByTicket("TICKET-A"), null);
    assert.equal(await otherRegistry.getDetail("SPRINT-A"), null);
  } finally { await f.close(); }
});

test("partial unbound and inconsistent bound records fail closed in detail and ticket lookup", async () => {
  const f = await fixture();
  try {
    await f.registry.register({ sprintId: "SPRINT-UNBOUND", position: 0 });
    const plan = await bindDraft(f);
    f.database.run("UPDATE sprint_registry SET plan_revision=1 WHERE sprint_id=?", ["SPRINT-UNBOUND"]);
    await assert.rejects(f.registry.getByTicket("TICKET-A"), { code: "SPRINT_PLAN_MISMATCH" });
    await assert.rejects(f.registry.getDetail("SPRINT-UNBOUND"), { code: "SPRINT_PLAN_MISMATCH" });
    f.database.run("UPDATE sprint_registry SET plan_revision=NULL WHERE sprint_id=?", ["SPRINT-UNBOUND"]);
    for (const [column, badValue, restored] of [["plan_revision", null, plan.revision], ["plan_path", "wrong.json", plan.file_path], ["plan_sha256", "0".repeat(64), plan.sha256]]) {
      f.database.run(`UPDATE sprint_registry SET ${column}=? WHERE sprint_id=?`, [badValue, "SPRINT-A"]);
      await assert.rejects(f.registry.getByTicket("TICKET-A"), { code: "SPRINT_PLAN_MISMATCH" });
      await assert.rejects(f.registry.getDetail("SPRINT-A"), { code: "SPRINT_PLAN_MISMATCH" });
      f.database.run(`UPDATE sprint_registry SET ${column}=? WHERE sprint_id=?`, [restored, "SPRINT-A"]);
    }
    f.database.run("UPDATE sprint_registry SET project_id=? WHERE sprint_id=?", ["PROJECT-B", "SPRINT-A"]);
    const otherPlans = createHumanPlanStore({ projectId: "PROJECT-B", database: f.database, fileService: f.fileService });
    const otherRegistry = createSprintRegistry({ projectId: "PROJECT-B", database: f.database, plans: otherPlans });
    await assert.rejects(otherRegistry.getByTicket("TICKET-A"), { code: "PLAN_REVISION_NOT_FOUND" });
  } finally { await f.close(); }
});

test("missing or tampered immutable files are not skipped as if unbound", async () => {
  const f = await fixture();
  try {
    const plan = await bindDraft(f);
    await f.fileService.atomicWrite({ path: plan.file_path, content: "{}\n", replace: true });
    await assert.rejects(f.registry.getByTicket("TICKET-A"), { code: "PLAN_HASH_MISMATCH" });
    await f.fileService.deleteFile({ path: plan.file_path });
    await assert.rejects(f.registry.getByTicket("TICKET-A"), { code: "PLAN_FILE_MISSING" });
  } finally { await f.close(); }
});
