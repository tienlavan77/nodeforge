/*
 * Business purpose: proves retrieval stop decisions prevent redundant candidate
 * discovery once verified evidence fully covers the request.
 * Technical description: exercises the governed candidate tool with a fresh,
 * complete context and asserts that neither selector side effects nor fallback
 * search calls occur.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/discovery/select-code-graph-candidates.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";

test("fresh complete evidence stops before selector or search side effects", async () => {
  let selectorCalls = 0;
  const context = {
    task_id: "stop-task",
    execution_id: "stop-run",
    conversation_id: "stop-conversation",
    delegation_id: "stop-delegation",
    project_root: process.cwd(),
    agent_identity: { agent_id: "coder", role: "coder" },
    capabilities: ["select_code_graph_candidates"],
    file_access_version: 2,
    evidence_fresh: true,
    coverage_complete: true,
    allowed_file_paths: [],
    allowed_prefixes: []
  };
  context.file_access_policy = issueExecutionFileAccess({
    context,
    readPaths: [],
    policyIdentity: { id: "stop-policy", revision: "1", sha256: `sha256:${"a".repeat(64)}` },
    authorizeCurrent: () => true
  });
  const tool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: {
      select: async () => { selectorCalls++; return { tree: [] }; }
    }
  });
  const result = await tool.execute({ query: "already covered" }, context);
  assert.equal(result.candidate_source, "stopped");
  assert.deepEqual(result.stop_policy, { decision: "stop", reason: "fresh_complete" });
  assert.equal(selectorCalls, 0);
});
