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

test("serves ticket candidate metadata with PATCH first, no file content", async () => {
  const { createSelectCodeGraphCandidatesTool } = await import("../../src/tools/select-code-graph-candidates.js");
  const probe = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: { select: () => { throw new Error("must not retrieve when ticket candidates exist"); } } });
  const candidateFiles = [
    { path: "ui/nextjs/components/Panel.jsx", role: "REUSE", symbol: "ConversationList", reason: "reuse ConversationList" },
    { path: "backend/src/application/service.js", role: "PATCH", symbol: "persistPin", reason: "edit persistPin" },
    { path: "ui/nextjs/components/Block.jsx", role: "PATCH", symbol: "PinButton", reason: "edit PinButton" },
    { path: "schemas/ticket.json", role: "REFERENCE", reason: "contract shape" }
  ];
  const result = await probe.execute({ query: "pin conversations" }, { task_id: "TASK-SL", capabilities: ["select_code_graph_candidates"], task_context: { title: "Pin", objective: "Pin conversations", acceptance_criteria: ["pin works"], candidate_files: candidateFiles } });
  assert.equal(result.candidate_source, "ticket");
  assert.deepEqual(result.selected.map((entry) => entry.path), ["backend/src/application/service.js", "ui/nextjs/components/Block.jsx", "ui/nextjs/components/Panel.jsx", "schemas/ticket.json"]);
  assert.ok(result.selected.every((entry) => !("content" in entry)), "must serve metadata only");
});

test("serves ticket symbol as the stable address", async () => {
  const { createSelectCodeGraphCandidatesTool } = await import("../../src/tools/select-code-graph-candidates.js");
  const probe = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: { select: () => { throw new Error("must not retrieve when ticket candidates exist"); } } });
  const candidateFiles = [{ path: "backend/src/application/service.js", role: "PATCH", symbol: "persistPin", reason: "edit persistPin" }];
  const result = await probe.execute({ query: "pin" }, { task_id: "TASK-SYMBOL", capabilities: ["select_code_graph_candidates"], task_context: { title: "Pin", objective: "Pin", acceptance_criteria: ["works"], candidate_files: candidateFiles } });
  assert.equal(result.selected[0].symbol, "persistPin");
  assert.ok(result.selected[0].reason.some((part) => part === "symbol:persistPin"));
});

test("serves up to eight ticket candidates in one call", async () => {
  const { createSelectCodeGraphCandidatesTool } = await import("../../src/tools/select-code-graph-candidates.js");
  const probe = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: { select: () => { throw new Error("must not retrieve when ticket candidates exist"); } } });
  const candidateFiles = Array.from({ length: 8 }, (_, i) => ({ path: `backend/src/application/service-${i}.js`, role: i < 5 ? "PATCH" : "REUSE", symbol: `handleService${i}`, reason: `entry ${i}` }));
  const result = await probe.execute({ query: "mixed backend frontend ticket" }, { task_id: "TASK-SL-8", capabilities: ["select_code_graph_candidates"], task_context: { title: "Mixed", objective: "Mixed", acceptance_criteria: ["both sides"], candidate_files: candidateFiles } });
  assert.equal(result.selected.length, 8);
  assert.deepEqual(result.selected.slice(0, 5).map((entry) => entry.path), candidateFiles.slice(0, 5).map((entry) => entry.path));
});

test("flags stale cached candidates with freshness instead of removing them", async () => {
  const { createSelectCodeGraphCandidatesTool } = await import("../../src/tools/select-code-graph-candidates.js");
  const probe = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: { select: () => { throw new Error("must not retrieve when ticket candidates exist"); } },
    freshnessChecker: { checkPaths: async (paths) => paths.map((path) => ({ path, status: path.endsWith("stale.js") ? "stale" : "fresh" })) }
  });
  const candidateFiles = [
    { path: "backend/src/application/fresh.js", role: "PATCH", symbol: "handleFresh", reason: "edit handleFresh" },
    { path: "backend/src/application/stale.js", role: "PATCH", symbol: "handleStale", reason: "edit handleStale" }
  ];
  const result = await probe.execute({ query: "freshness probe" }, { task_id: "TASK-FRESH", capabilities: ["select_code_graph_candidates"], task_context: { title: "Fresh", objective: "Fresh", acceptance_criteria: ["works"], candidate_files: candidateFiles } });
  assert.equal(result.candidate_source, "ticket");
  assert.equal(result.selected.length, 2);
  assert.deepEqual(result.stale_paths, ["backend/src/application/stale.js"]);
  assert.equal(result.freshness.fresh, 1);
  assert.equal(result.freshness.stale, 1);
  const stale = result.selected.find((entry) => entry.path === "backend/src/application/stale.js");
  assert.equal(stale.stale, true);
  assert.ok(stale.reason.some((part) => part.includes("stale:index-stale-needs-verify")));
  assert.equal(stale.symbol, "handleStale");
  assert.ok(result.selected.every((entry) => !("content" in entry)), "must serve metadata only");
  assert.match(result.freshness_note, /flagged, not removed/);
});
