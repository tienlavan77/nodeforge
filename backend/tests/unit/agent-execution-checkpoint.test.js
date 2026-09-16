import assert from "node:assert/strict";
import test from "node:test";

import { createAgentExecutionCheckpointStore } from "../../src/modules/agent/agent-execution-checkpoint.js";

function memoryFileService() {
  const files = new Map();
  return {
    files,
    atomicWrite: async ({ path, content }) => { files.set(path, content); },
    readFile: async ({ path }) => {
      if (!files.has(path)) { const error = new Error(`ENOENT: ${path}`); error.code = "ENOENT"; throw error; }
      return files.get(path);
    },
    deleteFile: async ({ path }) => {
      if (!files.has(path)) { const error = new Error(`ENOENT: ${path}`); error.code = "ENOENT"; throw error; }
      files.delete(path);
    },
    listFiles: async ({ glob }) => {
      const prefix = glob.replace(/\/\*\.json$/, "/");
      return [...files.keys()].filter((path) => path.startsWith(prefix) && path.endsWith(".json"));
    }
  };
}

test("saves and loads a per-turn checkpoint", async () => {
  const store = createAgentExecutionCheckpointStore({ fileService: memoryFileService() });
  const saved = await store.save({ task_id: "T-1", attempt: 1, last_completed_turn: 3, tool_events: [{ tool: "read_file", status: "success" }] });
  assert.equal(saved.task_id, "T-1");
  assert.equal(saved.last_completed_turn, 3);
  const loaded = await store.load("T-1");
  assert.equal(loaded.last_completed_turn, 3);
  assert.deepEqual(loaded.tool_events, [{ tool: "read_file", status: "success" }]);
});

test("load returns null when no checkpoint exists", async () => {
  const store = createAgentExecutionCheckpointStore({ fileService: memoryFileService() });
  assert.equal(await store.load("MISSING"), null);
});

test("clear removes the checkpoint", async () => {
  const fileService = memoryFileService();
  const store = createAgentExecutionCheckpointStore({ fileService });
  await store.save({ task_id: "T-2", last_completed_turn: 1 });
  await store.clear("T-2");
  assert.equal(await store.load("T-2"), null);
});

test("complete retains the checkpoint and excludes it from pending", async () => {
  const store = createAgentExecutionCheckpointStore({ fileService: memoryFileService() });
  await store.save({ task_id: "T-A", last_completed_turn: 2 });
  await store.save({ task_id: "T-B", last_completed_turn: 5 });
  await store.complete("T-A", { completed_tools: ["read_file", "report_done"] });
  const completed = await store.load("T-A");
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.completed_tools, ["read_file", "report_done"]);
  const pending = await store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].task_id, "T-B");
});

test("rejects unsafe task ids", async () => {
  const store = createAgentExecutionCheckpointStore({ fileService: memoryFileService() });
  await assert.rejects(() => store.save({ task_id: "../evil" }), /unsafe/);
  await assert.rejects(() => store.save({}), /task_id/);
});
