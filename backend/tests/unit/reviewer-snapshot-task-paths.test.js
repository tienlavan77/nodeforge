// Business purpose: keeps review discovery useful when task text names files outside the reviewed revision.
// Technical behavior: exercises every snapshot selector method with absent explicit paths and a one-file limit.
import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshotCandidateSelector } from "../../src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js";

const methods = ["select", "selectFresh", "selectWithEmbeddings", "selectFreshWithEmbeddings"];

// Business purpose: proves task-provided paths cannot displace committed review evidence.
// Technical behavior: checks task text aliases and caller hints against a pinned corpus before limiting.
test("snapshot task paths outside the corpus cannot displace the pinned candidate", async () => {
  const source = {
    reviewCommit: "a".repeat(40),
    listFiles: async () => ["backend/pinned.js"],
    readForIndex: async ({ path }) => ({ path, content: "export function committed() { return 1; }\n" })
  };
  const relevantTreeSelector = Object.fromEntries(methods.map((method) => [method, () => {
    throw new Error("Live selection must never run during snapshot review.");
  }]));
  const selector = createSnapshotCandidateSelector({ relevantTreeSelector, source });
  for (const method of methods) {
    for (const text of [
      { title: "schemas/ghost.json" },
      { objective: "schemas/ghost.json" },
      { acceptanceCriteria: ["schemas/ghost.json"] },
      { acceptance_criteria: ["schemas/ghost.json"] },
      { guardrails: ["schemas/ghost.json"] },
      { query: "committed schemas/ghost.json" }
    ]) {
      const result = await selector[method]({
        query: "committed", ...text, limit: 1,
        allowedPaths: ["schemas/ghost.json"],
        priorFiles: ["schemas/ghost.json"],
        dependencyFiles: [{ path: "schemas/ghost.json" }]
      });
      assert.deepEqual(result.tree.map((entry) => entry.path), ["backend/pinned.js"], method + JSON.stringify(text));
      assert.equal(result.index_version, source.reviewCommit);
      assert.ok(result.tree[0].matched_symbols.some((symbol) => symbol.name === "committed"));
    }
    const explicit = await selector[method]({ title: "backend/pinned.js", limit: 1 });
    assert.deepEqual(explicit.tree.map((entry) => entry.path), ["backend/pinned.js"]);
    assert.ok(explicit.tree[0].reason.some((reason) => reason.startsWith("tier0:")));
  }
});
