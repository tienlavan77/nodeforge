import assert from "node:assert/strict";
import test from "node:test";
import { createForgeToolRegistry } from "../../src/tools/index.js";

const candidates = [
  { path: "src/high.js", score: 0.9, reason: ["search:high"], relations: [], confidence: "static", index_version: "IDX-7" },
  { path: "src/low.js", score: 0.4, reason: ["graph:dependency"], relations: [], confidence: "static", index_version: "IDX-7" }
];

function tool() { return createForgeToolRegistry({ protocolStorage: { get: async () => ({}) }, fileService: { readForIndex: async () => ({}) }, relevantTreeSelector: { select: () => ({ tree: candidates, index_version: "IDX-7" }) } }).select_code_graph_candidates; }

test("returns the Node-selected candidate set", async () => {
  const result = await tool().execute({ query: "high match", context: "fallback" }, { task_id: "TASK-1", capabilities: ["select_code_graph_candidates"], task_context: { title: "Task", objective: "Find high", acceptance_criteria: ["A"] }, candidates, index_version: "IDX-7" });
  assert.deepEqual(result.selected.map((entry) => entry.path), ["src/high.js", "src/low.js"]);
  assert.equal(result.selected[0].score, 0.9);
});

test("returns a normalized result shape", async () => {
  const result = await tool().execute({ query: "high match", context: "fallback" }, { task_id: "TASK-1", capabilities: ["select_code_graph_candidates"], task_context: { title: "Task", objective: "Find high", acceptance_criteria: ["A"] }, candidates, index_version: "IDX-7" });
  assert.equal(result.task_id, "TASK-1");
  assert.equal(result.query, "high match");
  assert.equal(result.index_version, "IDX-7");
  assert.equal(Array.isArray(result.selected), true);
});
