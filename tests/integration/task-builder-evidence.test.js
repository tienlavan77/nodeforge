import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createBuilderEvidenceStore } from "../../src/modules/projects/builder-evidence-store.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";
import { createTaskStore } from "../../src/modules/projects/task-store.js";

const projectId = "PROJECT-evidence";

test("persists a Task and Builder evidence linked through its Session", async () => {
  await withStores(async ({ taskStore, sessionStore, evidenceStore, database }) => {
    const task = createTask(taskStore, "TASK-A");
    const session = sessionStore.create({ taskId: task.id, agents: ["AGENT-BUILDER-A"] });
    const evidence = evidenceStore.record({
      taskId: task.id,
      sessionId: session.id,
      builderId: "AGENT-BUILDER-A",
      evidenceType: "implementation_summary",
      payload: { summary: "Implemented the requested guard.", changed_paths: ["src/auth.js"] }
    });

    assert.deepEqual(taskStore.get(task.id), task);
    assert.deepEqual(evidenceStore.byTask(task.id), [evidence]);
    assert.deepEqual(evidenceStore.bySession(session.id), [evidence]);
    assert.equal(database.all("SELECT COUNT(*) AS count FROM builder_evidence")[0].count, 1);

    const reopenedTaskStore = createTaskStore({ database, projectId });
    const reopenedSessionStore = createSessionStore({ database, projectId });
    const reopenedEvidenceStore = createBuilderEvidenceStore({ database, projectId, taskStore: reopenedTaskStore, sessionStore: reopenedSessionStore });
    assert.deepEqual(reopenedTaskStore.get(task.id), task);
    assert.deepEqual(reopenedEvidenceStore.bySession(session.id), [evidence]);
  });
});

test("rejects Builder evidence with an unknown task or session", async () => {
  await withStores(async ({ taskStore, sessionStore, evidenceStore }) => {
    const task = createTask(taskStore, "TASK-A");
    const session = sessionStore.create({ taskId: task.id, agents: ["AGENT-BUILDER-A"] });
    const base = { taskId: task.id, sessionId: session.id, builderId: "AGENT-BUILDER-A", evidenceType: "handoff", reference: "RESULT-001" };

    assert.throws(() => evidenceStore.record({ ...base, taskId: "TASK-MISSING" }), /task does not exist/);
    assert.throws(() => evidenceStore.record({ ...base, sessionId: "SESSION-MISSING" }), /session does not exist/);
  });
});

test("rejects evidence when its session belongs to another task or lacks required identity", async () => {
  await withStores(async ({ taskStore, sessionStore, evidenceStore }) => {
    const taskA = createTask(taskStore, "TASK-A");
    const taskB = createTask(taskStore, "TASK-B");
    const session = sessionStore.create({ taskId: taskA.id, agents: ["AGENT-BUILDER-A"] });
    const base = { taskId: taskA.id, sessionId: session.id, builderId: "AGENT-BUILDER-A", evidenceType: "handoff", reference: "RESULT-001" };

    assert.throws(() => evidenceStore.record({ ...base, taskId: taskB.id }), /does not belong to the task/);
    assert.throws(() => evidenceStore.record({ ...base, builderId: undefined }), /not part of the session/);
  });
});

async function withStores(run) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-task-evidence-"));
  const database = await openIndexDatabase(projectRoot);
  try {
    const taskStore = createTaskStore({ database, projectId, createId: () => "TASK-generated" });
    const sessionStore = createSessionStore({ database, projectId, createId: () => "SESSION-generated" });
    const evidenceStore = createBuilderEvidenceStore({ database, projectId, taskStore, sessionStore, createId: () => "EVIDENCE-generated", clock: () => new Date("2026-08-18T08:00:00Z") });
    await run({ taskStore, sessionStore, evidenceStore, database });
  } finally {
    await database.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function createTask(taskStore, id) {
  return taskStore.create({
    id,
    type: "feature",
    title: `Task ${id}`,
    status: "active",
    created_at: "2026-08-18T08:00:00Z"
  });
}
