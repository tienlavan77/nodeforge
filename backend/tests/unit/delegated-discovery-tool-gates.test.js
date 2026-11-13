// Prevents discovery tool factories from bypassing delegation policy or crashing
// before discovery begins. Exercises the actual gate call sites directly because
// owner registry wrappers can reject requests before a broken factory is reached.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRgSearchTool } from "../../src/tools/discovery/rg-search.js";
import { createRgFilesTool } from "../../src/tools/discovery/rg-files.js";
import { createSourceReadTool } from "../../src/tools/discovery/source-read.js";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/discovery/select-code-graph-candidates.js";
import { createGitReadTools } from "../../src/tools/discovery/git-read-tools.js";
import { createOwnerSearchTreeTool } from "../../src/tools/roles/owner-search-tree.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

// Verifies every previously unresolved gate returns the actionable delegation
// error before any filesystem, search, graph, or Git operation can execute.
test("direct discovery factories reject undelegated parents with structured errors", async (t) => {
  const projectRoot = process.cwd();
  const logger = { emit() {} };
  const fileService = {
    listFiles: async () => assert.fail("listing must not run before delegation"),
    listDirectories: async () => assert.fail("tree must not run before delegation"),
    readForIndex: async () => assert.fail("reading must not run before delegation")
  };
  const gitService = {
    status: async () => assert.fail("Git must not run before delegation"),
    diffWorkingTree: async () => assert.fail("Git must not run before delegation")
  };
  const cases = [
    ["search_text", createRgSearchTool({ projectRoot, logger, toolName: "search_text" }), { pattern: "gate", paths: ["backend/src"] }],
    ["list_files", createRgFilesTool({ projectRoot, logger, toolName: "list_files" }), {}],
    ["Read", createSourceReadTool({ projectRoot, fileService }), { file_path: "backend/src/example.js", symbol: "example" }],
    ["select_code_graph_candidates", createSelectCodeGraphCandidatesTool(), { query: "discovery gate" }],
    ["git_status", createGitReadTools({ gitService, logger }).git_status, {}],
    ["search_tree", createOwnerSearchTreeTool({ fileService, role: "system_engineer" }), { path: "backend/src" }]
  ];
  for (const [name, tool, input] of cases) {
    await t.test(name, async () => {
      const context = { task_id: "discovery-gate", execution_id: "parent-gate", mandatory_subagent_discovery: true, capabilities: [name] };
      await assert.rejects(() => tool.execute(input, context), (error) => {
        assert.equal(error.code, "SUBAGENT_REQUIRED");
        assert.equal(error.error_code, "SUBAGENT_REQUIRED");
        assert.equal(error.required_action, "delegate_subagent");
        assert.equal(error.details.blocked_tool, name);
        assert.ok(error.allowed_tools.includes("read_file"));
        return true;
      });
    });
  }
});

// Proves read-only delegated workers reach real discovery and symbol reads without
// requesting nested delegation, rather than merely passing the policy helper.
test("delegated workers can search, list, inspect metadata, and read symbols directly", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-discovery-worker-"));
  try {
    await writeFile(join(projectRoot, "feature.js"), "export function feature() { return 42; }\n");
    const fileService = createFileService({ projectRoot });
    const logger = { emit() {} };
    const context = {
      task_id: "worker-discovery", execution_id: "worker-execution",
      parent_execution_id: "parent-execution", subagentId: "discovery-worker",
      mandatory_subagent_discovery: true, read_only_enforced: true, subagent_depth: 1,
      capabilities: ["search_text", "list_files", "read_file", "Read", "search_tree"],
      agent_identity: { role: "system_engineer" }
    };
    const search = createRgSearchTool({ projectRoot, logger, toolName: "search_text" });
    assert.match((await search.execute({ pattern: "feature", paths: ["feature.js"] }, context)).stdout, /return 42/);
    const files = createRgFilesTool({ projectRoot, logger, toolName: "list_files" });
    assert.match((await files.execute({}, context)).stdout, /feature\.js/);
    const tree = createOwnerSearchTreeTool({ fileService, role: "system_engineer" });
    assert.ok((await tree.execute({}, context)).entries.some((entry) => entry.path === "feature.js"));
    const metadata = await createReadFileTool({ fileService }).execute({ path: "feature.js" }, context);
    assert.ok(metadata.symbol_map.some((symbol) => symbol.name === "feature"));
    const read = createSourceReadTool({ projectRoot, fileService });
    assert.match((await read.execute({ file_path: "feature.js", symbol: "feature" }, context)).content, /return 42/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
