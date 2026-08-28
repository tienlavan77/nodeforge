import assert from "node:assert/strict";
import test from "node:test";
import { createFilesystemAwareContextService } from "../../src/modules/agent/filesystem-aware-context-service.js";

function base(facts = ["memory fact"]) {
  return { buildContext: () => ({ projectFacts: facts, taskFacts: ["task fact"], currentTask: { id: "TASK-1" } }) };
}
function budget() { return { selectFacts: ({ facts, maxFacts }) => facts.slice(0, maxFacts) }; }

test("merges indexed symbol facts and enforces the budget", async () => {
  const calls = [];
  const service = createFilesystemAwareContextService({ baseContextService: base(), contextEngine: { build: (request) => { calls.push(request); return Promise.resolve({ index_version: "IDX-1", generated_at: "now", symbols: [{ name: "refreshSession", file: "src/session.js", kind: "function", start_line: 4, end_line: 9 }], files: [{ path: "src/session.js" }], dependencies: [] }); } }, budgetManager: budget(), maxFacts: 2 });
  const result = await service.buildContext({ projectId: "PROJECT-1", taskId: "TASK-1", query: "refreshSession", domain: "runtime" });
  assert.deepEqual(result.projectFacts, ["memory fact", "symbol refreshSession in src/session.js (function 4-9)"]);
  assert.equal(calls[0].task_id, "TASK-1");
  assert.equal(calls[0].include_dependencies, true);
  assert.equal(result.contextPack.index_version, "IDX-1");
});

test("skips the index for an empty query", async () => {
  let called = false;
  const service = createFilesystemAwareContextService({ baseContextService: base(), contextEngine: { build: () => { called = true; } }, budgetManager: budget() });
  const result = await service.buildContext({ projectId: "PROJECT-1", taskId: "TASK-1" });
  assert.equal(called, false);
  assert.deepEqual(result.projectFacts, ["memory fact"]);
  assert.equal(result.contextPack, null);
});

test("falls back to logical facts when the index fails and filters secret paths", async () => {
  const service = createFilesystemAwareContextService({ baseContextService: base(["safe", "file .env contains secret"]), contextEngine: { build: () => Promise.reject(new Error("index unavailable")) }, budgetManager: budget() });
  const result = await service.buildContext({ projectId: "PROJECT-1", taskId: "TASK-1", query: "missing" });
  assert.deepEqual(result.projectFacts, ["safe"]);
  assert.equal(result.contextPack, null);
});
