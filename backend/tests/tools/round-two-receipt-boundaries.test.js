// Exercises receipt reuse and symbolic delivery as separate gates so retrieval metadata
// cannot claim a read or survive changes to source bytes, revision or issued scope.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerCandidateSources, candidateSourceMetadata } from "../../src/tools/discovery/candidate-source-receipts.js";
import { createSourceReadTool } from "../../src/tools/discovery/source-read.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";

/** Supplies a revocable Node read grant and mutable source for read-boundary regression tests. */
function fixture() {
  const path = "backend/src/example.js";
  let content = "export function example() { return 1; }\n";
  const context = { task_id: "ticket", execution_id: "run", conversation_id: "conversation", source_revision: "a".repeat(40),
    project_root: process.cwd(), agent_identity: { agent_id: "se", role: "system_engineer" },
    capabilities: ["select_code_graph_candidates", "Read"], allowed_file_paths: [path], allowed_prefixes: [] };
  context.file_access_policy = issueExecutionFileAccess({ context, readPaths: [path],
    policyIdentity: { id: "policy", revision: "1", sha256: "sha256:" + "a".repeat(64) }, authorizeCurrent: () => true });
  context.file_access_version = 2;
  const fileService = { readForIndex: async () => ({ content, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` }) };
  return { path, context, fileService, change: (value) => { content = value; } };
}

test("verification does not imply symbol read; bounded current read marks success", async () => {
  const f = fixture();
  const [entry] = await registerCandidateSources([{ path: f.path }], f.context, { fileService: f.fileService });
  assert.equal(entry.receipt.status, "verified");
  assert.equal(entry.receipt.read_symbol, false);
  assert.equal(candidateSourceMetadata(entry), undefined);
  assert.ok(candidateSourceMetadata(JSON.parse(JSON.stringify(entry)), f.context));
  const read = createSourceReadTool({ fileService: f.fileService, projectRoot: process.cwd() });
  await read.execute({ file_path: f.path, symbol: "example" }, f.context);
  assert.equal(entry.receipt.read_symbol, true);
});

test("reuse requires pinned revision and exact scope and delegation", async () => {
  const f = fixture();
  const [entry] = await registerCandidateSources([{ path: f.path }], f.context, { fileService: f.fileService });
  for (const patch of [{ source_revision: undefined }, { source_revision: "b".repeat(40) }, { allowed_file_paths: [] }, { delegation_id: "other" }]) {
    assert.equal(candidateSourceMetadata(entry, { ...f.context, ...patch }), undefined);
  }
  const missing = fixture(); delete missing.context.source_revision;
  const [unavailable] = await registerCandidateSources([{ path: missing.path }], missing.context, { fileService: missing.fileService, logger: { warn() {} } });
  assert.equal(unavailable.receipt.status, "unavailable");
});

test("camelCase executionId supplies the persisted delegation identity", async () => {
  const f = fixture();
  const context = { ...f.context, execution_id: undefined, executionId: "camel-execution", delegation_id: undefined };
  const [entry] = await registerCandidateSources([{ path: f.path }], context, { fileService: f.fileService });
  assert.equal(entry.receipt.status, "verified");
  assert.equal(entry.execution_identity.delegation_id, "camel-execution");
  assert.ok(candidateSourceMetadata(entry, context));
});

test("source drift cannot pass symbolic delivery even with an old advertised hash", async () => {
  const f = fixture();
  const [entry] = await registerCandidateSources([{ path: f.path }], f.context, { fileService: f.fileService });
  f.change("export function renamed() { return 2; }\n");
  const fileService = { readForIndex: async () => ({ ...(await f.fileService.readForIndex()), sha256: entry.sha256 }) };
  const read = createSourceReadTool({ fileService, projectRoot: process.cwd() });
  await assert.rejects(read.execute({ file_path: f.path, symbol: "example" }, f.context), /current read_file metadata/);
  assert.equal(entry.receipt.read_symbol, false);
});
