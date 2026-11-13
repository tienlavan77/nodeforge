// Business purpose: keeps candidate retrieval available to authorized roles without weakening source or read-only boundaries.
// Technical description: exercises provider-neutral owner registries, ticket request advertising and pinned Reviewer source access.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";
import { engineeringToolDefinitions } from "../../src/tools/engineering-tool-catalog.js";

const path = "backend/src/example.js";
const content = "export function example() { return 'pinned'; }\n";
const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;

// Business purpose: isolates source identity from provider metadata during candidate access tests.
// Technical description: supplies the minimal role-scoped file service with stable committed bytes.
function source() {
  return {
    readForIndex: async () => ({ path, content, sha256, size_bytes: Buffer.byteLength(content) }),
    readFile: async () => content, atomicWrite: async () => {}, deleteFile: async () => {},
    listFiles: async () => [path], listDirectories: async () => []
  };
}

for (const role of ["architecture_manager", "system_engineer", "reviewer", "sprint_leader", "coder"]) {
  for (const provider of ["claude", "codex", "openai"]) {
    test(`${role}/${provider} can retrieve and read verified candidates in planning mode`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "candidate-role-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      let state = {};
      const context = { task_id: "owner", execution_id: "owner", project_root: root, planning_input_only: true,
        agent_identity: { agent_id: role, role, provider }, allowed_file_paths: [path], allowed_prefixes: [] };
      const tools = createOwnerConversationTools({ role, projectRoot: root, fileService: source(), context,
        conversationId: "owner", conversationStateStore: { get: async () => state, update: async (_, update) => { state = { ...state, ...update }; } },
        relevantTreeSelector: { select: () => ({ tree: [{ path }] }) },
        evidenceStore: { recordDirectEvidence: () => ({ durable: true }), snapshot: () => ({ evidence: [] }) } });
      context.capabilities = tools.definitions.map((definition) => definition.name);
      assert.equal(context.capabilities.includes("select_code_graph_candidates"), true);
      assert.equal(context.capabilities.includes("write_diff"), false);
      const result = await tools.registry.select_code_graph_candidates.execute({ query: "example" });
      assert.equal(result.selected[0].receipt.status, "verified");
      assert.equal(result.selected[0].evidence.durable, true);
      assert.equal(state.active_file_checksums[path].sha256, sha256);
      assert.match((await tools.registry.Read.execute({ file_path: path, symbol: "example" })).content, /pinned/);
    });
  }
}

test("sender advertises candidate definitions to Coder only with the issued capability", async () => {
  for (const enabled of [true, false]) {
    let advertised;
    const worker = createSenderWorker({
      queue: { claim: async () => ({ task_id: "ticket", agent_id: "coder", payload: { role: "coder", execution_context: { capabilities: enabled ? ["select_code_graph_candidates"] : [], agent_identity: { role: "coder" } } } }), ack: async () => {}, reject: async () => {} },
      agentRegistry: { resolve: () => ({ adapter: { send: async ({ tools }) => { advertised = tools; return { type: "session.result", summary: "done" }; } } }) },
      eventBus: { publish: async () => {} }, toolRegistry: {}
    });
    await worker.processOnce();
    assert.equal(advertised.some((definition) => definition.name === "select_code_graph_candidates"), enabled);
  }
});

test("Reviewer candidates and symbolic reads remain pinned to committed source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  const fileService = { ...source(), committedReview: true, reviewCommit: commit };
  const tools = createReviewerForgeTools({ fileService, projectRoot: root,
    job: { task_id: "review", request_id: "request", payload: { ticket: {
      candidate_files: [{ path: "backend/live-only.js", reason: "cached live winner", symbol: "forged" }]
    } } }, reviewer: { agent_id: "rv", provider: "codex" },
    relevantTreeSelector: { select: () => ({ tree: [{ path }] }) },
    codeCache: { read: async () => ({ path, content: "export function example() { return 'live'; }", sha256: "live" }) } });
  const result = await tools.registry.select_code_graph_candidates.execute({ query: "example" });
  assert.equal(result.selected[0].sha256, sha256);
  assert.equal(result.review_source.commit_sha, commit);
  assert.match((await tools.registry.Read.execute({ file_path: path, symbol: "example" })).content, /pinned/);
  assert.equal(tools.definitions.some((definition) => definition.name === "write_diff"), false);
});

test("candidate definition stays in the shared engineering catalog", () => {
  assert.equal(engineeringToolDefinitions().filter((definition) => definition.name === "select_code_graph_candidates").length, 1);
});
