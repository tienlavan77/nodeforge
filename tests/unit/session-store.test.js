import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { ProjectRegistry } from "../../src/modules/projects/project-registry.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";

test("creates a schema-valid session with a stable project_id and persists it after restart", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-session-store-"));
  let database;
  try {
    const projectId = await new ProjectRegistry({ createId: () => "PROJECT-session-test" }).getOrCreate(projectRoot);
    database = await openIndexDatabase(projectRoot);
    const store = createSessionStore({
      database,
      projectId,
      createId: () => "SESSION-001",
      clock: () => new Date("2026-08-17T08:00:00Z")
    });
    const created = store.create({ taskId: "TASK-001", agents: ["AGENT-opaque-string"] });
    assert.deepEqual(created, {
      id: "SESSION-001",
      project_id: "PROJECT-session-test",
      task_id: "TASK-001",
      agents: ["AGENT-opaque-string"],
      status: "active",
      started_at: "2026-08-17T08:00:00.000Z"
    });

    const closed = store.close(created.id, { summary: "Stored without Agent Protocol." });
    assert.equal(closed.status, "completed");
    await database.close();
    database = undefined;

    const restartedDatabase = await openIndexDatabase(projectRoot);
    database = restartedDatabase;
    const restartedStore = createSessionStore({ database, projectId });
    assert.deepEqual(restartedStore.get(created.id), closed);
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects session records that violate project/session.schema.json", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-session-store-invalid-"));
  let database;
  try {
    database = await openIndexDatabase(projectRoot);
    const store = createSessionStore({ database, projectId: "PROJECT-invalid", createId: () => "SESSION-invalid" });
    assert.throws(() => store.create({ agents: ["invalid agent id"] }), /Invalid session record/);
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
