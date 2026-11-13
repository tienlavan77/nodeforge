// Business purpose: prevents candidate receipt reuse from escaping current execution authority or masking stale cached source.
// Technical description: verifies Node-issued v2 scopes, revocation during reads, cached freshness failures and untrusted authority input.
import test from "node:test";
import assert from "node:assert/strict";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/discovery/select-code-graph-candidates.js";
import { createSourceReadTool } from "../../src/tools/discovery/source-read.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { recordSourceMetadata, sourceMetadataSymbol } from "../../src/tools/discovery/source-metadata-receipts.js";
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

test("missing current symbols are rejected without an uncontrolled exception", () => {
  const f = fixture();
  recordSourceMetadata(f.context, { path, sha256: "sha256:" + "b".repeat(64), symbol_map: [{ name: "example", start_line: 1, end_line: 1 }], source_revision: f.context.source_revision });
  assert.equal(sourceMetadataSymbol(f.context, path, "example", "sha256:" + "b".repeat(64), undefined), null);
});

test("camelCase executions keep symbolic receipts isolated by execution", () => {
  const agent = { agent_id: "reviewer", role: "reviewer" };
  const base = { agent_identity: agent, conversationId: "conversation", source_revision: "a".repeat(40), allowedFilePaths: [path], allowedPrefixes: [] };
  const first = { ...base, executionId: "run-one", delegationId: "delegation-one" };
  const second = { ...base, executionId: "run-two", delegationId: "delegation-two" };
  const firstSha = "sha256:" + "1".repeat(64);
  const secondSha = "sha256:" + "2".repeat(64);
  const symbol = { name: "example", start_line: 1, end_line: 1 };
  recordSourceMetadata(first, { path, sha256: firstSha, symbol_map: [symbol], source_revision: first.sourceRevision });
  recordSourceMetadata(second, { path, sha256: secondSha, symbol_map: [symbol], source_revision: second.sourceRevision });
  assert.deepEqual(sourceMetadataSymbol(first, path, "example", firstSha, symbol), symbol);
  assert.deepEqual(sourceMetadataSymbol(second, path, "example", secondSha, symbol), symbol);
  assert.equal(sourceMetadataSymbol(first, path, "example", secondSha, symbol), null);
});

test("camelCase candidate receipts reach Read without crossing executions", async () => {
  const contentByExecution = new Map([["run-one", "export function example() { return 1; }\n"], ["run-two", "export function example() { return 2; }\n"]]);
  const contexts = ["run-one", "run-two"].map((executionId) => ({ taskId: "ticket", executionId, conversationId: "conversation", delegationId: executionId,
    source_revision: "a".repeat(40), project_root: process.cwd(), agent_identity: { agent_id: executionId, role: "reviewer" }, capabilities: ["select_code_graph_candidates"], allowed_file_paths: [path], allowedFilePaths: [path], allowed_prefixes: [], allowedPrefixes: [] }));
  const tool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector: { select: () => ({ tree: [{ path }] }) },
    fileService: { readForIndex: async () => ({ content: contentByExecution.get(contexts.find((context) => context.executionId === currentExecution)?.executionId) }) } });
  let currentExecution = "run-one";
  const first = await tool.execute({ query: "example" }, contexts[0]);
  currentExecution = "run-two";
  const second = await tool.execute({ query: "example" }, contexts[1]);
  const read = createSourceReadTool({ fileService: { readForIndex: async () => ({ content: contentByExecution.get(currentExecution) }) }, projectRoot: process.cwd() });
  currentExecution = "run-one";
  assert.match((await read.execute({ file_path: path, symbol: "example" }, contexts[0])).content, /return 1/);
  currentExecution = "run-two";
  assert.match((await read.execute({ file_path: path, symbol: "example" }, contexts[1])).content, /return 2/);
  assert.notEqual(first.selected[0].receipt_id, second.selected[0].receipt_id);
  await assert.rejects(read.execute({ file_path: path, symbol: "example" }, { ...contexts[0], executionId: "run-two" }), /current read_file metadata/);
});

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
