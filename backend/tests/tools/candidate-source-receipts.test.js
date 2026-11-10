// Business purpose: protects one-touch retrieval from granting symbolic access on stale or fabricated candidate metadata.
// Technical description: exercises live and ticket-cache selection, private receipt verification, durability failures and scoped cross-role evidence reuse.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/discovery/select-code-graph-candidates.js";
import { createSourceReadTool } from "../../src/tools/discovery/source-read.js";
import { createSubagentEvidenceStore } from "../../src/tools/discovery/subagent-evidence-store.js";
import { createSubagentEvidenceTool } from "../../src/tools/discovery/subagent-evidence-tool.js";
import { syncToolResultToEvidenceStore } from "../../src/tools/discovery/subagent-evidence-sync.js";

const path = "backend/src/example.js";
const content = "// Business purpose: supplies a stable source symbol for receipt verification.\nexport function example() { return 7; }\n";
const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;

// Business purpose: models an authorized source independently of candidate metadata and index checksums.
// Technical description: creates isolated role stores and a mutable source service so tests can reproduce source drift.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "candidate-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = content;
  const fileService = { readForIndex: async ({ path: requested }) => {
    if (requested !== path) throw new Error("Unapproved source");
    return { path, content: current, sha256: `sha256:${createHash("sha256").update(current).digest("hex")}` };
  } };
  const store = createSubagentEvidenceStore({ projectRoot: root, projectId: root });
  const selector = { selectFreshWithEmbeddings: async () => ({ tree: [{ path, sha256: "forged", symbol_map: [{ name: "invented" }], matched_symbols: [{ name: "example" }] }] }) };
  // Business purpose: keeps role provenance and source permissions explicit during handoff assertions.
  // Technical description: binds each role to the same plan and a distinct execution identity.
  const context = (role = "system_engineer", cached = false) => ({
    task_id: role, execution_id: role, conversation_id: role, project_root: root,
    agent_identity: { agent_id: role, role }, capabilities: ["select_code_graph_candidates"],
    allowed_file_paths: [path], allowed_prefixes: [],
    task_context: cached ? { candidate_files: [{ path, role: "PATCH" }] } : {},
    evidence_scope: { projectRoot: root, projectId: root, planId: "plan", conversationId: `${root}:${role}`, delegationId: `${root}:${role}`, role }
  });
  return { root, fileService, store, selector, context, change: (value) => { current = value; } };
}

for (const cached of [false, true]) {
  test(`${cached ? "cached" : "live"} candidates register verified live metadata and durable parent provenance`, async (t) => {
    const f = await fixture(t);
    const context = f.context("system_engineer", cached);
    const tool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: f.selector, fileService: f.fileService, evidenceStore: f.store, projectRoot: f.root });
    const result = await tool.execute({ query: "example" }, context);
    const entry = result.selected[0];
    assert.equal(entry.sha256, sha256);
    assert.equal(entry.receipt.status, "verified");
    assert.equal(entry.evidence.durable, true);
    assert.equal(entry.symbol_map.some((symbol) => symbol.name === "example"), true);
    assert.equal(entry.symbol_map.some((symbol) => symbol.name === "invented"), false);
    assert.equal(context.active_file_checksums[path].sha256, sha256);
    const read = createSourceReadTool({ fileService: f.fileService, projectRoot: f.root });
    assert.match((await read.execute({ file_path: path, symbol: "example" }, context)).content, /return 7/);
    f.change(content + "// changed\n");
    await assert.rejects(read.execute({ file_path: path, symbol: "example" }, context), /current read_file metadata/);
  });
}

test("stale, unreadable and out-of-scope candidates do not receive source receipts", async (t) => {
  const f = await fixture(t);
  t.mock.method(console, "warn", () => {});
  const context = f.context();
  const tool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: { select: () => ({ tree: [{ path }, { path: "backend/src/denied.js" }], stale_paths: [path] }) },
    fileService: f.fileService, evidenceStore: f.store, projectRoot: f.root
  });
  const result = await tool.execute({ query: "stale" }, context);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].receipt.read_symbol, false);
  assert.equal(result.selected[0].fresh, undefined);
  assert.equal(context.active_file_checksums, undefined);
  const unavailable = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: f.selector });
  assert.equal((await unavailable.execute({ query: "unreadable" }, f.context())).selected[0].receipt.status, "unavailable");
});

for (const throws of [false, true]) {
  test(`durability ${throws ? "exception" : "failure"} remains distinct from a verified source receipt`, async (t) => {
    const f = await fixture(t);
    t.mock.method(console, "warn", () => {});
    const evidenceStore = { recordDirectEvidence: () => { if (throws) throw new Error("disk unavailable"); return { durable: false }; } };
    const tool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: f.selector, fileService: f.fileService, evidenceStore, projectRoot: f.root });
    const result = await tool.execute({ query: "example" }, f.context());
    assert.equal(result.selected[0].receipt.status, "verified");
    assert.equal(result.selected[0].evidence.status, "failed");
    assert.equal(result.selected[0].evidence.durable, false);
  });
}

test("evidence synchronization cannot promote fabricated selected metadata", () => {
  let calls = 0;
  syncToolResultToEvidenceStore({ toolName: "select_code_graph_candidates",
    result: { selected: [{ path, sha256, receipt: { status: "verified" }, symbol_map: [] }] },
    evidenceStore: { recordDirectEvidence: () => { calls++; } } });
  assert.equal(calls, 0);
});

test("AM to SE to RV handoff preserves exact source identity, scope and freshness", async (t) => {
  const f = await fixture(t);
  const am = f.context("architecture_manager");
  const tool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: f.selector, fileService: f.fileService, evidenceStore: f.store, projectRoot: f.root });
  const selected = (await tool.execute({ query: "example" }, am)).selected[0];
  const evidence = createSubagentEvidenceTool({ evidenceStore: f.store, fileService: f.fileService, projectRoot: f.root });
  for (const role of ["system_engineer", "reviewer"]) {
    const context = f.context(role);
    const receipt = (await evidence.execute({}, context)).evidence.find((entry) => entry.path === path);
    assert.equal(receipt.fresh, true);
    assert.equal(receipt.sha256, selected.sha256);
    assert.deepEqual(receipt.symbol_map, selected.symbol_map);
    assert.equal(receipt.source_worker_id, "parent:architecture_manager");
    assert.equal(context.active_file_checksums[path].sha256, sha256);
    const read = createSourceReadTool({ fileService: f.fileService, projectRoot: f.root });
    assert.match((await read.execute({ file_path: path, symbol: "example" }, context)).content, /return 7/);
  }
  f.change(content + "// stale\n");
  const stale = (await evidence.execute({}, f.context("reviewer"))).evidence[0];
  assert.equal(stale.fresh, false);
  assert.equal(stale.stale, true);
});
