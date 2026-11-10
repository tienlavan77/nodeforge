// Verifies that Reviewer candidate discovery cannot expose live index paths or metadata after a review revision is pinned.
import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotCandidateSelector } from "../../src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js";

test("snapshot candidate discovery binds paths and symbols to committed source", async () => {
  const contents = new Map([["backend/pinned.js", "export function committed() { return 1; }\n"]]);
  const source = {
    reviewCommit: "a".repeat(40),
    listFiles: async () => [...contents.keys()],
    readForIndex: async ({ path }) => ({ path, content: contents.get(path) })
  };
  const liveSelector = {
    selectFreshWithEmbeddings: async () => ({
      index_version: "live-index",
      tree: [
        { path: "backend/live-only.js", score: 99, matched_symbols: [{ name: "liveOnly" }], relations: [{ path: "backend/live-related.js" }] },
        { path: "backend/pinned.js", score: 1, matched_symbols: [{ name: "liveSymbol" }], relations: [{ path: "backend/live-related.js" }] }
      ]
    })
  };
  const selector = createSnapshotCandidateSelector({ relevantTreeSelector: liveSelector, source });
  const result = await selector.selectFreshWithEmbeddings({ query: "committed" });

  assert.deepEqual(result.tree.map((entry) => entry.path), ["backend/pinned.js"]);
  assert.deepEqual(result.tree[0].relations, []);
  assert.equal(result.tree[0].matched_symbols[0].name, "committed");
});
