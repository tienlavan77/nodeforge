// Business purpose: prevents candidate receipt reuse from escaping current execution authority or masking stale cached source.
// Technical description: verifies Node-issued v2 scopes, revocation during reads, cached freshness failures and untrusted authority input.
import test from "node:test";
import assert from "node:assert/strict";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/discovery/select-code-graph-candidates.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { sourceMetadataSymbol } from "../../src/tools/discovery/source-metadata-receipts.js";
const path = "backend/src/example.js";
const content = "export function example() { return 7; }\n";

// Business purpose: supplies a genuine Node grant so candidate tests cannot bypass the execution provenance gate.
// Technical description: binds the read path and a revocable current-authority resolver to a Reviewer identity.
function fixture() {
  let authorized = true;
  const context = { task_id: "ticket", execution_id: "run", source_revision: "a".repeat(40), project_root: process.cwd(),
    agent_identity: { agent_id: "reviewer", role: "reviewer" }, capabilities: ["select_code_graph_candidates"], allowed_file_paths: [path], allowed_prefixes: [] };
  context.file_access_policy = issueExecutionFileAccess({ context, readPaths: [path],
    policyIdentity: { id: "policy", revision: "1", sha256: "sha256:" + "a".repeat(64) }, authorizeCurrent: () => authorized });
  context.file_access_version = 2;
  return { context, revoke: () => { authorized = false; } };
}

test("v2 candidate retrieval excludes paths outside the issued read scope", async () => {
  const f = fixture();
  const readPaths = [];
  const tool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: { select: () => ({ tree: [{ path }, { path: "backend/src/denied.js" }] }) },
    fileService: { readForIndex: async ({ path: current }) => { readPaths.push(current); return { content }; } },
    evidenceStore: { recordDirectEvidence: () => ({ durable: true }) }
  });
  const result = await tool.execute({ query: "example" }, f.context);
  assert.deepEqual(readPaths, [path]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].receipt.status, "verified");
  f.revoke();
  await assert.rejects(tool.execute({ query: "example" }, f.context), /authority|revoked/);
});

test("revocation while reading cannot deliver a candidate or register metadata", async (t) => {
  const f = fixture();
  t.mock.method(console, "warn", () => {});
  const tool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: { select: () => ({ tree: [{ path }] }) },
    fileService: { readForIndex: async () => { f.revoke(); return { content }; } }
  });
  await assert.rejects(tool.execute({ query: "example" }, f.context), /authority|revoked/);
  assert.equal(sourceMetadataSymbol(f.context, path, "example", "unverified"), null);
  assert.equal(f.context.active_file_checksums, undefined);
});

test("stale cached candidates stay unverified and allow a later scoped retrieval", async (t) => {
  t.mock.method(console, "warn", () => {});
  const context = { task_id: "cached", agent_identity: { role: "system_engineer" }, capabilities: ["select_code_graph_candidates"],
    allowed_file_paths: [path], allowed_prefixes: [], task_context: { candidate_files: [{ path }] } };
  let fresh = false;
  const tool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: { select: () => ({ tree: [{ path }] }) },
    freshnessChecker: { checkPaths: async () => [{ path, status: fresh ? "fresh" : "stale" }] },
    fileService: { readForIndex: async () => ({ content }) }, evidenceStore: { recordDirectEvidence: () => ({ durable: true }) }
  });
  assert.equal((await tool.execute({ query: "example" }, context)).selected[0].receipt.status, "unavailable");
  assert.equal(context.active_file_checksums, undefined);
  fresh = true;
  assert.equal((await tool.execute({ query: "example" }, context)).selected[0].receipt.status, "verified");
});

test("serialized receipt reuse requires the current execution and scope", async () => {
  const f = fixture();
  const tool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: { select: () => ({ tree: [{ path }] }) },
    fileService: { readForIndex: async () => ({ content }) },
    evidenceStore: { recordDirectEvidence: () => ({ durable: true }) }
  });
  const first = await tool.execute({ query: "example" }, f.context);
  const entry = first.selected[0];
  assert.equal(entry.receipt.status, "verified");
  const contextWithoutIdentity = { ...f.context, execution_id: undefined, conversation_id: undefined };
  assert.equal((await import("../../src/tools/discovery/candidate-source-receipts.js")).candidateSourceMetadata(entry, contextWithoutIdentity), undefined);
  const mismatchedScope = { ...f.context, allowed_file_paths: ["backend/src/other.js"] };
  assert.equal((await import("../../src/tools/discovery/candidate-source-receipts.js")).candidateSourceMetadata(entry, mismatchedScope), undefined);
});

test("candidate input cannot replace path or execution authority", async () => {
  const f = fixture();
  const tool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: { select: () => ({ tree: [] }) } });
  for (const input of [{ query: "x", path }, { query: "x", allowed_prefixes: ["backend/"] }, { query: "x", task_id: "other" }]) {
    await assert.rejects(tool.execute(input, f.context), (error) => error.code === "TOOL_INPUT_INVALID");
  }
});

test("conversation semantic fields reach retrieval without issuing caller supplied authority", async () => {
  let args;
  const tool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: { select: (input) => { args = input; return { tree: [] }; } } });
  await tool.execute({ title: "Title", objective: "Objective", acceptance_criteria: ["criterion"], guardrails: ["guardrail"] },
    { conversation_id: "conversation", agent_identity: { role: "system_engineer" }, capabilities: ["select_code_graph_candidates"] });
  assert.equal(args.title, "Title");
  assert.deepEqual(args.acceptance_criteria, ["criterion"]);
  assert.deepEqual(args.guardrails, ["guardrail"]);
});
