// Verifies project-isolated production session persistence, retry recovery, and fail-closed validation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSessionStore, createTaskSessionPreparation } from "../../src/modules/projects/session-store.js";

// Provides real root-bound storage while excluding agent execution from persistence checks.
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "session-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root });
  const tasks = new Map();
  const taskStore = { get: (id) => tasks.get(id), create: (task) => tasks.set(task.id, task) };
  return { fileService, taskStore, tasks, store: createSessionStore({ projectId: "PROJECT-A", fileService }) };
}

test("sessions survive concurrent ensure, preparation retry, restart and terminal reuse", async (context) => {
  const f = await fixture(context);
  const input = { task_id: "TASK-A", project_id: "PROJECT-A" };
  const results = await Promise.all(Array.from({ length: 6 }, () => f.store.ensureForTask(input)));
  for (const session of results) assert.deepEqual(session, results[0]);
  const prepare = createTaskSessionPreparation({ projectId: "PROJECT-A", fileService: f.fileService, taskStore: f.taskStore });
  assert.deepEqual(await prepare(input), { session_id: "SESSION-TASK-A" });
  assert.equal(f.tasks.size, 1);
  const terminal = { ...results[0], status: "completed", finished_at: new Date().toISOString() };
  await f.fileService.atomicWrite({ path: ".forge/runtime/nf/sessions/SESSION-TASK-A.json", content: JSON.stringify(terminal), replace: true });
  const restarted = createSessionStore({ projectId: "PROJECT-A", fileService: f.fileService });
  assert.deepEqual(await restarted.ensureForTask(input), terminal);
  assert.deepEqual(await prepare(input), { session_id: terminal.id });
  assert.deepEqual(await restarted.get(terminal.id), terminal);
});

test("preparation repairs task-only state after a propagated session write failure", async (context) => {
  const f = await fixture(context);
  const failure = Object.assign(new Error("disk unavailable"), { code: "EIO" });
  const failingFiles = { ...f.fileService, atomicCreate: async () => { throw failure; } };
  const failed = createTaskSessionPreparation({ projectId: "PROJECT-A", taskStore: f.taskStore, fileService: failingFiles });
  await assert.rejects(failed({ task_id: "TASK-A" }), { code: "EIO" });
  assert.equal(f.tasks.size, 1);
  assert.equal(await f.store.get("SESSION-TASK-A"), undefined);
  const recovered = createTaskSessionPreparation({ projectId: "PROJECT-A", taskStore: f.taskStore, fileService: f.fileService });
  await recovered({ task_id: "TASK-A" });
  assert.equal((await f.store.get("SESSION-TASK-A")).project_id, "PROJECT-A");
  assert.equal(f.tasks.size, 1);
});

test("project conflicts and unsafe identifiers reject before any task or session writes", async (context) => {
  const f = await fixture(context);
  const prepare = createTaskSessionPreparation({ projectId: "PROJECT-A", taskStore: f.taskStore, fileService: f.fileService });
  for (const input of [
    { task_id: "TASK-A", project_id: "PROJECT-B" },
    { task_id: "TASK-A", ticket: { project_id: "PROJECT-B" } },
    { task_id: "TASK-A", project_id: ["PROJECT-A", "PROJECT-B"] }
  ]) await assert.rejects(prepare(input), { code: "PROJECT_CONTEXT_CONFLICT" });
  for (const taskId of ["../TASK", "TASK/A", "TASK\\A", "", null]) {
    await assert.rejects(prepare({ task_id: taskId }), /safe single path components/);
    await assert.rejects(f.store.ensureForTask({ task_id: taskId }), /safe single path components/);
  }
  await assert.rejects(f.store.get("../SESSION"), /safe single path components/);
  assert.equal(f.tasks.size, 0);
  assert.equal(await f.store.get("SESSION-TASK-A"), undefined);
});

test("corrupt, schema-invalid and cross-project sessions are never reused or overwritten", async (context) => {
  const f = await fixture(context);
  const input = { task_id: "TASK-A" };
  const session = await f.store.ensureForTask(input);
  const path = ".forge/runtime/nf/sessions/SESSION-TASK-A.json";
  const invalidRecords = [
    "{",
    JSON.stringify({ ...session, project_id: undefined }),
    JSON.stringify({ ...session, project_id: ["PROJECT-A", "PROJECT-B"] }),
    JSON.stringify({ ...session, started_at: "not-a-timestamp" }),
    JSON.stringify({ ...session, project_id: "PROJECT-B" }),
    JSON.stringify({ ...session, task_id: "TASK-B" }),
    JSON.stringify({ ...session, id: "SESSION-TASK-B" })
  ];
  for (const content of invalidRecords) {
    await f.fileService.atomicWrite({ path, content, replace: true });
    await assert.rejects(f.store.ensureForTask(input));
    assert.equal(await f.fileService.readFile({ path }), content);
  }
});
