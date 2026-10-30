// Verifies that Node-issued discovery grants cannot expand ticket writes, survive serialization,
// bypass governance classification, or restore authority from an unverified resume checkpoint.
import assert from "node:assert/strict";
import test from "node:test";
import { issueExecutionFileAccess, assertExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { isAgentPathAllowed } from "../../src/tools/governance/tool-authorization.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";
import { scopedGraph } from "../../src/tools/discovery/agent-file-index-view.js";
import { createSearchCodeTool } from "../../src/tools/discovery/search-code.js";

// Identifies synthetic Node authority without borrowing a production policy approval or credential.
const policyIdentity = { id: "test-policy", revision: "1", sha256: `sha256:${"a".repeat(64)}` };

// Supplies an authority resolver owned by the test's Node side, never by serialized agent arguments.
function fixture(overrides = {}, policy = {}) {
  const context = { task_id: "TICKET", execution_id: "EXECUTION", project_root: process.cwd(),
    agent_identity: { agent_id: "CODER", role: "coder", provider: "claude" },
    capabilities: ["read_file", "read_lines", "write_diff", "edit_diff"],
    allowed_file_paths: ["backend/target.js"], allowed_prefixes: [], changed_paths: [],
    execution_context: { approved_baseline: { file_checksums: { "backend/target.js": null } } }, ...overrides };
  const options = { readPaths: ["package.json"], readPrefixes: ["backend", "docs", "workflows", "vocabulary"],
    policyIdentity, authorizeCurrent: () => true, ...policy };
  context.file_access_policy = issueExecutionFileAccess({ ...options, context });
  context.file_access_version = 2;
  return { context, options };
}

test("Coder authority permits reads and writes outside the immutable evidence manifest", async () => {
  const { context } = fixture();
  const calls = [];
  const registry = Object.fromEntries(["read_lines", "write_diff"].map((name) => [name, { execute: async (input) => { calls.push(input.path); return {}; } }]));
  const bound = bindEngineeringTools({ registry, context });
  await bound.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 1 });
  await bound.registry.write_diff.execute({ path: "backend/caller.js", before_checksum: null, content: "x" });
  await bound.registry.write_diff.execute({ path: "backend/target.js", before_checksum: null, content: "x" });
  assert.deepEqual(calls, ["backend/caller.js", "backend/caller.js", "backend/target.js"]);
  context.allowed_file_paths.push("backend/escape.js");
  assert.equal(isAgentPathAllowed("backend/escape.js", context, { operation: "write" }), true);
  assert.equal(isAgentPathAllowed("backend-extra/caller.js", context), true);
});

test("Coder writes include governance and dependencies while aliases and Git metadata remain denied", () => {
  const paths = ["workflows/plan.md", "AGENTS.md", "backend/CLAUDE.md", "ARCHITECTURE.md", "vocabulary/glossary.md", "node_modules/package/index.js"];
  const { context } = fixture({ allowed_file_paths: paths }, { readPrefixes: ["backend", "workflows", "vocabulary", "node_modules"] });
  for (const path of paths) assert.equal(isAgentPathAllowed(path, context, { operation: "write" }), true, path);
  for (const path of ["backend/../outside", "backend//file", "/backend/file", "backend\\file", ".git/config"]) {
    assert.equal(isAgentPathAllowed(path, context), false, path);
  }
  assert.equal(isAgentPathAllowed("workflows/plan.md", context), true);
});

test("Coder documentation writes do not need another role classification", () => {
  const { context } = fixture({ allowed_file_paths: ["docs/guide.md", "docs/governance.md"], allowed_prefixes: ["docs"] },
    { authorizeDocsWrite: ({ path }) => path === "docs/guide.md" });
  assert.equal(isAgentPathAllowed("docs/guide.md", context, { operation: "write" }), true);
  assert.equal(isAgentPathAllowed("docs/governance.md", context, { operation: "write" }), true);
  assert.equal(isAgentPathAllowed("docs/other.md", context, { operation: "write" }), true);
  const unclassified = fixture({ allowed_file_paths: ["docs/guide.md"] }).context;
  assert.equal(isAgentPathAllowed("docs/guide.md", unclassified, { operation: "write" }), true);
});

test("missing, serialized and cross-execution grants fail closed", () => {
  const { context } = fixture();
  for (const changed of [{ file_access_policy: undefined }, { file_access_policy: structuredClone(context.file_access_policy) },
    { file_access_version: undefined }, { file_access_version: 3 }, { task_id: "OTHER" }, { execution_id: "OTHER" }, { project_root: "/another-project" },
    { agent_identity: { agent_id: "OTHER", role: "coder" } }]) {
    assert.throws(() => assertExecutionFileAccess({ ...context, ...changed }), { code: "FILE_ACCESS_POLICY_INVALID" });
  }
  assert.equal(isAgentPathAllowed("backend/a.js", { agent_identity: { role: "coder" } }), true);
  assert.equal(isAgentPathAllowed("docs/a.md", { agent_identity: { role: "coder" } }), true);
});

test("current-authority callback controls revocation and post-read delivery", async () => {
  let active = true;
  const { context } = fixture({}, { authorizeCurrent: () => active });
  const bound = bindEngineeringTools({ context, registry: { read_lines: { execute: async () => { active = false; return { stdout: "do not deliver" }; } } } });
  await assert.rejects(bound.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 1 }), { code: "FILE_ACCESS_POLICY_INVALID" });
  assert.throws(() => isAgentPathAllowed("backend/caller.js", context), { code: "FILE_ACCESS_POLICY_INVALID" });
});

test("Reviewer cannot borrow write authority and unsupported Codex CLI access is not admitted", () => {
  const reviewer = fixture({ agent_identity: { agent_id: "REVIEWER", role: "reviewer" } }).context;
  assert.equal(isAgentPathAllowed("backend/caller.js", reviewer), true);
  assert.equal(isAgentPathAllowed("backend/target.js", reviewer, { operation: "write" }), false);
  const codex = fixture({ agent_identity: { agent_id: "CODER", role: "coder", provider: "codex" } }).context;
  assert.throws(() => bindEngineeringTools({ registry: {}, context: codex }), { code: "FILE_ACCESS_PROVIDER_UNSUPPORTED" });
});

test("verification subprocesses stay locked until versioned filesystem enforcement is certified", async () => {
  const { context } = fixture({ capabilities: ["run_check"] });
  const bound = bindEngineeringTools({ context, registry: { run_check: { execute: () => assert.fail("Uncertified subprocess must not run") } } });
  await assert.rejects(bound.registry.run_check.execute({ type: "test", command: "node --test backend/test.js" }), { code: "TOOL_LOCKED" });
});

test("runtime dispatch preserves issued identity with project-wide Coder mutation authority", async () => {
  const { context, options } = fixture();
  const governance = createRuntimeToolGovernance({ fileAccessPolicy: options });
  const { file_access_policy, file_access_version, ...input } = context;
  assert.ok(file_access_policy && file_access_version);
  const current = governance.createExecutionContext(input);
  let received;
  await governance.dispatch("read_lines", { path: "backend/caller.js" }, current, async (_input, issuedContext) => { received = issuedContext; return {}; });
  assert.equal(received.file_access_policy, current.file_access_policy);
  assert.equal(isAgentPathAllowed("backend/caller.js", received), true);
  assert.doesNotThrow(() => governance.authorize("write_diff", current, "backend/caller.js"));
  assert.throws(() => governance.authorize("write_diff", current, "../outside.js"), { code: "TOOL_RESOURCE_FORBIDDEN" });
  assert.throws(() => governance.authorize("read_lines", { ...current, file_access_policy: structuredClone(current.file_access_policy) }, "backend/caller.js"), { code: "FILE_ACCESS_POLICY_INVALID" });
  assert.throws(() => createRuntimeToolGovernance().createExecutionContext(context), { code: "FILE_ACCESS_POLICY_INVALID" });
});

test("resume cannot manufacture new authority from checkpoint fields", () => {
  assert.throws(() => fixture({ resume_checkpoint: true }), { code: "FILE_ACCESS_POLICY_INVALID" });
  assert.throws(() => fixture({ resume_checkpoint: true }, { authorizeResume: () => false }), { code: "FILE_ACCESS_POLICY_INVALID" });
  assert.doesNotThrow(() => fixture({ resume_checkpoint: true }, { authorizeResume: () => true }));
  assert.throws(() => fixture({}, { authorizeCurrent: async () => true }), { code: "FILE_ACCESS_POLICY_INVALID" });
});

test("Coder writes are independent of create prefixes and mutable file budgets", async () => {
  const baseline = { file_checksums: { "backend/target.js": null }, authorized_create_prefixes: ["backend/new"], mutable_file_budget: 2 };
  const { context } = fixture({ authorized_create_prefixes: ["backend/new"], execution_context: { approved_baseline: baseline } });
  const bound = bindEngineeringTools({ context, registry: { write_diff: { execute: async (input, current) => { current.changed_paths.push(input.path); return {}; } } } });
  await bound.registry.write_diff.execute({ path: "backend/new/first.js", before_checksum: null, content: "x" });
  await bound.registry.write_diff.execute({ path: "backend/new/second.js", before_checksum: null, content: "x" });
  await bound.registry.write_diff.execute({ path: "backend/newer/a.js", before_checksum: null, content: "x" });
  assert.equal(bound.context.changed_paths.length, 3);
});

test("read metadata and index graph edges cannot expose paths denied by the read grant", async () => {
  const { context } = fixture({ capabilities: ["search_code"], agent_identity: { agent_id: "REVIEWER", role: "reviewer" } });
  const graph = { imports: [{ path: "backend/caller.js" }, { path: "backend/secrets/fixture.js" }, { path: "ui/outside.js" }] };
  assert.deepEqual(scopedGraph(graph, context).imports, [{ path: "backend/caller.js" }]);
  const tool = createSearchCodeTool({ codeSearch: { search: async () => ({ matches: [
    { node: { path: "backend/caller.js", graph } }, { node: { path: "backend/secrets/fixture.js", snippet: "PRIVATE" } }
  ] }) } });
  const result = await tool.execute({ query: "caller", kind: "file", limit: 5, projection: "graph", allowed_prefixes: ["backend"] }, context);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].graph.imports, [{ path: "backend/caller.js" }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secrets|outside/);
});
