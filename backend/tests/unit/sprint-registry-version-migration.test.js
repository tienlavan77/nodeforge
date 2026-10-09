// Verifies additive Registry versioning preserves pre-version scheduling data and survives reopening.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";

test("version-17 scheduling rows migrate without data loss and version persists on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-registry-version-"));
  const options = { dataDir: join(root, ".forge/runtime"), runtimeDir: "." };
  let database;
  try {
    database = await createDatabaseService(options);
    database.run("INSERT INTO sprint_registry (sprint_id,project_id,position,dependencies_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", ["SPRINT-OLD", "PROJECT-A", 0, "[]", "planned", "original-created", "original-updated"]);
    // Recreates the pre-version schema only inside this disposable database.
    database.run("ALTER TABLE sprint_registry DROP COLUMN version");
    database.run("DELETE FROM schema_migrations WHERE version=18");
    const original = database.all("SELECT * FROM sprint_registry")[0];
    await database.close();

    database = await createDatabaseService(options);
    assert.deepEqual(database.all("SELECT * FROM sprint_registry")[0], { ...original, version: 0 });
    const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
    const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
    const updated = await registry.setStatus({ sprintId: "SPRINT-OLD", status: "blocked", expectedVersion: 0 });
    assert.equal(updated.version, 1);
    await database.close();

    database = await createDatabaseService(options);
    assert.equal(database.all("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=18")[0].count, 1);
    const restarted = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
    assert.deepEqual(restarted.get("SPRINT-OLD"), updated);
    await assert.rejects(restarted.setStatus({ sprintId: "SPRINT-OLD", status: "blocked", expectedVersion: 0 }), { code: "SPRINT_REGISTRY_CONFLICT" });
    assert.deepEqual(restarted.get("SPRINT-OLD"), updated);
  } finally { await database?.close(); await rm(root, { recursive: true, force: true }); }
});
