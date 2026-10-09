// Verifies offline legacy Sprint migration, exact preview identity, backup integrity and restart-safe additive imports.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fork } from "node:child_process";
import { once } from "node:events";
import { sprintMigrationFixture, PROJECT, REVIEW } from "../fixtures/sprint-registry-migration-fixture.mjs";
import { openSprintMigrationRuntime } from "../../scripts/sprint-registry-migration-runtime.mjs";
import { runSprintMigration, parseSprintMigrationArgs } from "../../scripts/migrate-sprint-registry.mjs";
import { acquireProcessLock } from "../../scripts/nodeforge-process-lock.mjs";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { migrationHash } from "../../src/application/sprint-registry-migration-preview.js";

// Runs an action against actual migration storage and guarantees lock cleanup for subsequent restarts.
async function runtimeAction(fixture, mode, action) {
  const runtime = await openSprintMigrationRuntime({ config: fixture.config, mode });
  try { return await action(runtime); } finally { runtime.close(); }
}

// Applies only the explicitly captured manifest; no test grants human approval or provider RUN.
async function apply(fixture, manifest) {
  return runtimeAction(fixture, "apply", (runtime) => runtime.service.apply({ project_id: PROJECT, manifest, manifest_sha256: manifest.manifest_sha256 }));
}

// Captures a read-only preview using the same runtime adapter as the maintenance CLI.
async function preview(fixture, supplements = {}) {
  return runtimeAction(fixture, "preview", (runtime) => runtime.service.preview({ project_id: PROJECT, supplements }));
}

test("preview is read-only and apply resolves dashboard migration without transferring approval", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const before = f.database.all("SELECT * FROM governance_roadmaps");
  const manifest = await preview(f);
  assert.equal(manifest.can_apply, true);
  assert.equal(manifest.entries.length, 1);
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 0);
  assert.equal(f.database.all("SELECT * FROM sprint_registry").length, 0);
  assert.equal((await readdir(f.config.dataDir)).some((name) => /migration|lock/.test(name)), false);
  const receipt = await apply(f, manifest);
  assert.equal(receipt.approval_granted, false);
  assert.equal(receipt.execution_started, false);
  assert.ok(receipt.receipt_path);
  assert.deepEqual(f.database.all("SELECT * FROM governance_roadmaps"), before);
  assert.equal(f.tickets.getMetadata("TICKET-MIGRATION").context, "Private owner context");
  await runtimeAction(f, "preview", async (runtime) => {
    const service = createProjectDashboardService({ roadmaps: f.roadmaps, sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => null, getSprintBacklog: () => [] }, sprintRegistry: runtime.registry, ticketFileStore: f.tickets });
    const dashboard = await service.getDashboard(PROJECT);
    assert.equal(dashboard.roadmap.sprints[0].tasks[0].id, "TICKET-MIGRATION");
    await assert.rejects(runtime.plans.assertExecutable({ planId: manifest.entries[0].plan_id, revision: 1, sha256: receipt.imported[0].plan_sha256 }));
  });
  assert.equal(f.database.all("SELECT * FROM plan_decisions").length, 0);
  const backupManifest = JSON.parse(await readFile(join(receipt.backup.path, "backup-manifest.json"), "utf8"));
  assert.equal(migrationHash(backupManifest.files), receipt.backup.sha256);
  for (const file of backupManifest.files) assert.equal(createHash("sha256").update(await readFile(join(receipt.backup.path, file.path))).digest("hex"), file.sha256);
  const snapshot = new DatabaseSync(join(receipt.backup.path, "index.db"), { readOnly: true });
  try { assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM sprint_registry").get().count, 0); } finally { snapshot.close(); }
});

test("reapplying the original manifest after restart does not create duplicate records", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f);
  const first = await apply(f, manifest);
  const second = await apply(f, manifest);
  assert.deepEqual(first.imported, second.imported);
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 1);
  assert.equal(f.database.all("SELECT * FROM sprint_registry").length, 1);
});

test("missing human review scope blocks migration until an explicit source-bound supplement is supplied", async (t) => {
  const f = await sprintMigrationFixture({ includeReview: false }); t.after(f.close);
  const blocked = await preview(f);
  assert.equal(blocked.can_apply, false);
  assert.ok(blocked.blockers.some((item) => item.code === "SPRINT_MIGRATION_SCOPE_INCOMPLETE"));
  await assert.rejects(apply(f, blocked), { code: "SPRINT_MIGRATION_MANIFEST" });
  const supplied = await preview(f, { "SPRINT-MIGRATION": REVIEW });
  assert.equal(supplied.can_apply, true);
  await apply(f, supplied);
  assert.equal(f.roadmaps.getCurrent().sprints[0].human_plan, undefined);
});

test("preview recovers a metadata-referenced Sprint from roadmap history when the current roadmap omits it", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const current = structuredClone(f.roadmaps.getCurrent().sprints[0]);
  current.id = "SPRINT-CURRENT";
  current.roadmap_id = "ROADMAP-CURRENT";
  current.tickets = current.tickets.map((ticket) => ({ ...ticket, id: "TICKET-CURRENT", roadmap_id: current.roadmap_id, sprint_id: current.id }));
  f.upload.upload({ projectId: PROJECT, sprintPlan: current });
  const manifest = await preview(f);
  assert.deepEqual(manifest.entries.map((entry) => entry.sprint_id), ["SPRINT-MIGRATION", "SPRINT-CURRENT"]);
  assert.equal(manifest.can_apply, true);
});

test("needs_human_review without an active execution or retained launch claim does not block migration", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  f.statuses.create("TICKET-MIGRATION");
  f.statuses.updateStatus("TICKET-MIGRATION", "running");
  f.statuses.updateStatus("TICKET-MIGRATION", "needs_human_review");
  const manifest = await preview(f);
  assert.equal(manifest.can_apply, true);
  assert.equal(f.statuses.get("TICKET-MIGRATION").status, "needs_human_review");
});

test("tickets persisted outside their latest legacy Sprint scope are reported as a scope conflict", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const sprint = structuredClone(f.roadmaps.getCurrent().sprints[0]);
  sprint.tickets.push({ ...structuredClone(sprint.tickets[0]), id: "TICKET-SECOND", title: "Second scoped ticket" });
  f.roadmaps.save({ ...f.roadmaps.getCurrent(), version: "ROADMAP-MIGRATION-SECOND", sprints: [sprint] });
  f.roadmaps.removeTicket(PROJECT, "TICKET-MIGRATION");
  const manifest = await preview(f);
  assert.ok(manifest.blockers.some((item) => item.code === "SPRINT_MIGRATION_TICKET_SCOPE_CONFLICT" && item.identifier === "SPRINT-MIGRATION" && item.ticket_count === 1));
});

test("wrong project, forged manifest and changed legacy source are rejected before import", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f);
  await runtimeAction(f, "preview", (runtime) => assert.rejects(runtime.service.preview({ project_id: "PROJECT-OTHER" }), { code: "SPRINT_MIGRATION_PROJECT" }));
  await assert.rejects(apply(f, { ...manifest, entries: [] }), { code: "SPRINT_MIGRATION_MANIFEST" });
  f.roadmaps.updateTicket({ projectId: PROJECT, ticketId: "TICKET-MIGRATION", patch: { title: "Changed after preview" } });
  await assert.rejects(apply(f, manifest), { code: "SPRINT_MIGRATION_STALE" });
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 0);
});

test("live runtime locks and concurrent maintenance adapter refuse apply", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const control = acquireProcessLock(f.config.dataDir, "control");
  try {
    assert.equal((await preview(f)).can_apply, true);
    await assert.rejects(openSprintMigrationRuntime({ config: f.config, mode: "apply" }), /process already running/);
  } finally { control.release(); }
  await runtimeAction(f, "apply", async () => {
    await assert.rejects(openSprintMigrationRuntime({ config: f.config, mode: "apply" }), /process already running/);
  });
  assert.equal((await readdir(f.config.dataDir)).some((name) => name.endsWith(".lock")), false);
});

test("retained launch claims block migration even after a failed execution status", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  f.statuses.create("TICKET-MIGRATION", { launch_claim: { claim_id: "UNKNOWN-OUTCOME" } });
  const manifest = await preview(f);
  assert.equal(manifest.can_apply, false);
  assert.ok(manifest.blockers.some((item) => item.code === "SPRINT_MIGRATION_EXECUTION_UNRECONCILED"));
  await assert.rejects(apply(f, manifest), { code: "SPRINT_MIGRATION_MANIFEST" });
});

test("restart recovers an exact unindexed immutable plan file without approval", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f);
  const entry = manifest.entries[0];
  const plan = await runtimeAction(f, "apply", (runtime) => runtime.plans.createRevision({ planId: entry.plan_id, sprintId: entry.sprint_id, expectedRevision: 0, content: entry.content }));
  f.database.transaction(() => {
    f.database.run("DELETE FROM plan_heads WHERE plan_id=?", [entry.plan_id]);
    f.database.run("DELETE FROM plan_revisions WHERE plan_id=?", [entry.plan_id]);
  });
  await apply(f, manifest);
  assert.equal(f.database.all("SELECT sha256 FROM plan_revisions")[0].sha256, plan.sha256);
  assert.equal(f.database.all("SELECT * FROM plan_decisions").length, 0);
});

test("restart after indexed plan but before Registry insertion reuses the first revision", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f); const entry = manifest.entries[0];
  await runtimeAction(f, "apply", (runtime) => runtime.plans.createRevision({ planId: entry.plan_id, sprintId: entry.sprint_id, expectedRevision: 0, content: entry.content }));
  await apply(f, manifest);
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 1);
});

test("orphan tickets, history drift and changed imported scheduling remain reconciliation blockers", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f);
  await apply(f, manifest);
  f.database.run("UPDATE sprint_registry SET version=version+1 WHERE sprint_id=?", ["SPRINT-MIGRATION"]);
  await assert.rejects(apply(f, manifest), { code: "SPRINT_MIGRATION_CONFLICT" });
  f.tickets.update({ ticket: { ...f.tickets.readLatest("TICKET-MIGRATION"), title: "History drift" } });
  assert.ok((await preview(f)).blockers.some((item) => item.code === "SPRINT_MIGRATION_TICKET_DRIFT"));
});

test("CLI validates project and explicit preview checksum and shares the actual maintenance flow", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  assert.throws(() => parseSprintMigrationArgs(["apply", "--project", PROJECT]), { code: "SPRINT_MIGRATION_INPUT" });
  assert.throws(() => parseSprintMigrationArgs(["preview", "--project", "PROJECT-OTHER"]), { code: "SPRINT_MIGRATION_PROJECT" });
  assert.throws(() => parseSprintMigrationArgs(["preview", "--project", PROJECT, "--sql", "DELETE"]), { code: "SPRINT_MIGRATION_INPUT" });
  const manifest = await runSprintMigration(["preview", "--project", PROJECT], f.config);
  const path = join(f.config.cwd, "preview.json");
  await writeFile(path, JSON.stringify(manifest));
  const receipt = await runSprintMigration(["apply", "--project", PROJECT, "--manifest", path, "--sha256", manifest.manifest_sha256], f.config);
  assert.equal(receipt.imported.length, 1);
});

test("another process holding maintenance ownership rejects migration apply", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f);
  const child = fork(new URL("../fixtures/sprint-registry-migration-worker.mjs", import.meta.url), ["hold", JSON.stringify(f.config)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, "exit");
  const [ready] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Maintenance worker exited before readiness."); })]);
  assert.equal(ready.ready, true);
  await assert.rejects(apply(f, manifest), /process already running/);
  child.send({ release: true });
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  await apply(f, manifest);
});

test("abrupt process death after plan file creation is recovered on restart", async (t) => {
  const f = await sprintMigrationFixture(); t.after(f.close);
  const manifest = await preview(f);
  const path = join(f.config.cwd, "crash-preview.json");
  await writeFile(path, JSON.stringify(manifest));
  const child = fork(new URL("../fixtures/sprint-registry-migration-worker.mjs", import.meta.url), ["crash-after-file", JSON.stringify(f.config), path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 17);
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 0);
  await apply(f, manifest);
  assert.equal(f.database.all("SELECT * FROM plan_revisions").length, 1);
  assert.equal(f.database.all("SELECT * FROM sprint_registry").length, 1);
  assert.equal(f.database.all("SELECT * FROM plan_decisions").length, 0);
});
