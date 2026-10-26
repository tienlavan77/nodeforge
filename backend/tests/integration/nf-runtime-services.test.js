// Proves real control-runtime services retain their SQLite references across offline regrouping.
// Fixtures cover indexed conversation offsets, immutable plan approval, and sprint backup adapters
// without opening live project databases or depending on an external model or gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { migrateNfRuntime } from "../../src/infrastructure/filesystem/nf-runtime-migration.js";
import { resolveRuntimePath } from "../../src/infrastructure/filesystem/forge-paths.js";
import { sprintMigrationFixture } from "../fixtures/sprint-registry-migration-fixture.mjs";
import { openSprintMigrationRuntime } from "../../scripts/sprint-registry-migration-runtime.mjs";

// Indexed raw_file and immutable plan paths must remain unchanged through restart and new writes.
test("real conversation and approved-plan services retain SQLite references after nf cutover", async context => {
  const scratch = join(process.cwd(), ".forge/scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "nf-services-"));
  let database = await createDatabaseService({ dataDir: join(root, ".forge/runtime/nf"), runtimeDir: "." });
  context.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  const fileService = createFileService({ projectRoot: root });
  const communications = createAgentCommunicationStore({ database, fileService });
  const message = { id: "MSG-NF", project_id: "PROJECT-NF", sender: { id: "OWNER", role: "project_owner" }, recipient: { id: "NODE", role: "node" },
    message_type: "owner.message", conversation_id: "CONV-NF", correlation_id: "CORR-NF", payload: { text: "Retained conversation" }, timestamp: "2026-10-26T00:00:00Z" };
  communications.append(message);
  const indexed = database.all("SELECT raw_file,byte_offset,byte_length FROM agent_communications");
  const rawBefore = await fileService.readFile({ path: ".forge/runtime/nf/" + indexed[0].raw_file });
  const plans = createMarkdownPlanStore({ projectId: "PROJECT-NF", database, fileService });
  await fileService.atomicWrite({ path: "workflows/summary.md", content: "# Scope", replace: false });
  const plan = await plans.createRevision({ planId: "PLAN-NF", markdown: "# Plan", summaryPath: "workflows/summary.md",
    summarySha256: createHash("sha256").update("# Scope").digest("hex") });
  await plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER" });
  const input = { planId: plan.plan_id, revision: 1, sha256: plan.sha256 };
  await database.close();
  await migrateNfRuntime(root, { apply: true, offline: true, sdkStopped: true });
  database = await createDatabaseService({ dataDir: join(root, ".forge/runtime/nf"), runtimeDir: "." });
  const restarted = createAgentCommunicationStore({ database, fileService });
  assert.equal(restarted.getById("MSG-NF").payload.text, "Retained conversation");
  assert.deepEqual(database.all("SELECT raw_file,byte_offset,byte_length FROM agent_communications"), indexed);
  assert.equal(await readFile(resolveRuntimePath(root, ".forge/runtime/nf/" + indexed[0].raw_file), "utf8"), rawBefore);
  restarted.append({ ...message, id: "MSG-NF-2", payload: { text: "Continued conversation" } });
  assert.equal(restarted.getByConversationId("CONV-NF").length, 2);
  const restoredPlans = createMarkdownPlanStore({ projectId: "PROJECT-NF", database, fileService });
  assert.equal((await restoredPlans.assertApproved(input)).sha256, plan.sha256);
});

// Sprint migration preview and backup must read grouped plans and ticket history through the new paths.
test("sprint migration adapter reads grouped source and writes grouped backups", async context => {
  const fixture = await sprintMigrationFixture();
  context.after(() => fixture.close());
  const before = await openSprintMigrationRuntime({ config: fixture.config, mode: "preview" });
  const source = await before.readSource();
  before.close();
  await fixture.database.close();
  await migrateNfRuntime(fixture.config.cwd, { apply: true, offline: true, sdkStopped: true });
  const after = await openSprintMigrationRuntime({ config: fixture.config, mode: "preview" });
  let manifest;
  try {
    const grouped = await after.readSource();
    assert.deepEqual(grouped, source);
    manifest = await after.service.preview({ project_id: fixture.config.projectId });
  } finally { after.close(); }
  const apply = await openSprintMigrationRuntime({ config: fixture.config, mode: "apply" });
  try {
    const receipt = await apply.service.apply({ project_id: fixture.config.projectId, manifest, manifest_sha256: manifest.manifest_sha256 });
    assert.ok(receipt.backup.path.startsWith(join(fixture.config.cwd, ".forge/runtime/nf/maintenance/sprint-migration-backups")));
    assert.ok(receipt.receipt_path.startsWith(join(fixture.config.cwd, ".forge/runtime/nf/maintenance/sprint-migration-receipts")));
    const backup = JSON.parse(await readFile(join(receipt.backup.path, "backup-manifest.json"), "utf8"));
    assert.ok(backup.files.some(file => file.path.startsWith("tickets/")));
  } finally { apply.close(); }
});
