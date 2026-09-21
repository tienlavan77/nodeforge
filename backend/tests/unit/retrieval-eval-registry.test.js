// Summary: Verifies retrieval eval candidate lookup uses the Forge registry execution chain.

import assert from "node:assert/strict";
import test from "node:test";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { selectEvalCandidates } from "../eval/retrieval-eval-registry.js";

test("retrieval eval calls select_code_graph_candidates through registry.execute", async () => {
  const calls = [];
  const registry = createForgeToolRegistry({
    protocolStorage: { get: async () => null },
    fileService: { readForIndex: async () => null },
    relevantTreeSelector: { selectFreshWithEmbeddings: async (args) => { calls.push(args); return { tree: [{ path: "backend/src/example.js" }] }; } },
    projectLogger: () => {}
  });
  const caseItem = { id: "case-1", title: "Find example", objective: "Locate example", acceptance_criteria: ["It works"], style: ["backend"] };

  const result = await selectEvalCandidates({ registry, caseItem, limit: 8 });
  assert.deepEqual(result.selected, [{ path: "backend/src/example.js" }]);
  assert.equal(calls[0].title, "Find example");
  assert.equal(calls[0].objective, "Locate example");
  assert.equal(calls[0].limit, 8);
});
