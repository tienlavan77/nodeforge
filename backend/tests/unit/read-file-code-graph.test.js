// Verifies that metadata-only source discovery retains readable graph relationships for SE
// through Code Cache, while respecting explicit scopes, protected paths and stale indexes.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";

// Exercises the cache-to-agent metadata pipeline without returning source or borrowing live state.
test("SE read_file preserves fresh graph and filters restricted or stale relationships", async () => {
  const content = "export function compact() { return true; }\n";
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  let indexedSha256 = sha256;
  const fileService = { readForIndex: async () => ({ content, sha256 }) };
  const graph = {
    imports: [{ path: "backend/src/helper.js" }, { path: "../outside.js" }],
    imported_by: [{ path: "backend/src/caller.js" }],
    calls: [{ caller: { path: "backend/src/example.js" }, target: { path: "backend/src/helper.js" } },
      { caller: { path: "backend/src/example.js" }, target: { path: "../outside.js" } }]
  };
  const cache = createCodeCacheService({ projectId: "graph-test", fileService,
    codeSearch: { fileMetadata: () => ({ sha256: indexedSha256, symbols: [], graph }) } });
  try {
    const tool = createReadFileTool({ fileService, codeCache: cache });
    const context = { agent_identity: { role: "system_engineer" }, project_wide_access: true };
    const input = { path: "backend/src/example.js" };
    const result = await tool.execute(input, context);
    assert.equal(result.index_status, "fresh");
    assert.equal(Object.hasOwn(result, "content"), false);
    assert.deepEqual(result.code_graph, { imports: [graph.imports[0]], imported_by: graph.imported_by, calls: [graph.calls[0]] });
    const architecture = await tool.execute(input, { agent_identity: { role: "architecture_manager" } });
    assert.equal(Object.hasOwn(architecture, "content"), false);
    assert.deepEqual(architecture.code_graph, result.code_graph);
    const scoped = await tool.execute(input, { ...context, allowed_file_paths: [input.path] });
    assert.deepEqual(scoped.code_graph, { imports: [], imported_by: [], calls: [] });
    indexedSha256 = `sha256:${"0".repeat(64)}`;
    const stale = await tool.execute(input, context);
    assert.equal(stale.index_status, "stale");
    assert.deepEqual(stale.code_graph, {});
  } finally { cache.close(); }
});
