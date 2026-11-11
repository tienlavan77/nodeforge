// Verifies reproducible Reviewer discovery from pinned source despite live index changes.
// Exercises every supported retrieval surface and the legacy select-only fallback.
import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotCandidateSelector } from "../../src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js";

// Business purpose: isolates review evidence from later workspace edits.
// Technical behavior: provides immutable source bytes and a complete pinned path listing.
function pinnedSource() {
  const contents = new Map([
    ["backend/pinned.js", "export function committed() { return 1; }\n"],
    ["backend/other.js", "export function unrelated() { return 2; }\n"]
  ]);
  return {
    reviewCommit: "a".repeat(40),
    listFiles: async () => [...contents.keys()],
    readForIndex: async ({ path }) => ({ path, content: contents.get(path) })
  };
}

test("snapshot rankings and metadata ignore live-only paths, scores, symbols and freshness", async () => {
  let calls = 0;
  let live = { tree: [{ path: "backend/live-only.js", score: 99 }], index_version: "live" };
  // Business purpose: detects accidental live retrieval during a pinned review.
  // Technical behavior: counts calls while allowing the live response to change between requests.
  const selectLive = async () => { calls++; return live; };
  const methods = ["select", "selectFresh", "selectWithEmbeddings", "selectFreshWithEmbeddings"];
  const selector = createSnapshotCandidateSelector({
    relevantTreeSelector: Object.fromEntries(methods.map((name) => [name, selectLive])),
    source: pinnedSource()
  });
  const baseline = await selector.select({ query: "committed", limit: 1 });
  assert.deepEqual(baseline.tree.map((entry) => entry.path), ["backend/pinned.js"]);
  assert.equal(baseline.tree[0].matched_symbols[0].name, "committed");
  assert.deepEqual(baseline.tree[0].relations, []);
  assert.deepEqual(baseline.tree[0].node, { path: "backend/pinned.js", index_version: "a".repeat(40) });
  assert.equal(baseline.index_version, "a".repeat(40));
  live = {
    tree: [{ path: "backend/other.js", score: 1000, node: { id: "live" },
      matched_symbols: [{ name: "forged" }], stale: true }],
    freshness: { stale: 500 }, stale_paths: ["backend/pinned.js"], index_version: "changed"
  };
  for (const method of methods) {
    assert.deepEqual(await selector[method]({ query: "committed", limit: 1 }), baseline);
  }
  assert.equal(calls, 0);
  assert.equal(baseline.freshness, undefined);
  assert.equal(baseline.stale_paths, undefined);
});

test("snapshot selector preserves select-only support and awaits pinned reads", async () => {
  const selector = createSnapshotCandidateSelector({
    relevantTreeSelector: { select: () => { throw new Error("Live selector must not run"); } },
    source: pinnedSource()
  });
  assert.deepEqual(Object.keys(selector), ["select"]);
  const result = await selector.select({ query: "committed" });
  assert.equal(result.tree[0].path, "backend/pinned.js");
});

test("snapshot selection propagates unexpected pinned source errors", async () => {
  const selector = createSnapshotCandidateSelector({
    relevantTreeSelector: { select: () => ({ tree: [] }) },
    source: { ...pinnedSource(), readForIndex: async () => { throw new Error("corrupt snapshot"); } }
  });
  await assert.rejects(selector.select({ query: "committed" }), /corrupt snapshot/);
});

test("snapshot candidates exclude live-only prior and dependency paths before limiting", async () => {
  const selector = createSnapshotCandidateSelector({
    relevantTreeSelector: { select: () => { throw new Error("Live selector must not run"); } },
    source: pinnedSource()
  });
  const result = await selector.select({ query: "committed", limit: 1,
    scope: "changed", prior_files: ["backend/live-only.js", "backend/pinned.js"],
    dependency_files: ["backend/live-dependency.js"] });
  assert.deepEqual(result.tree.map((entry) => entry.path), ["backend/pinned.js"]);
});
