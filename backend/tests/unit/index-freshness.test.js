// Summary: Unit tests for index freshness classification and selectFresh demotion.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyFreshness, createIndexFreshnessChecker } from "../../src/modules/index/index-freshness.js";
import { createRelevantTreeSelector } from "../../src/modules/index/relevant-tree.js";

test("classifies fresh, stale, missing, and unreadable", () => {
  assert.equal(classifyFreshness({ sha256: "abc" }, { sha256: "sha256:abc" }, { path: "a.js" }).status, "fresh");
  assert.equal(classifyFreshness({ sha256: "abc" }, { sha256: "def" }, { path: "a.js" }).status, "stale");
  assert.equal(classifyFreshness(null, { sha256: "def" }, { path: "a.js" }).status, "missing");
  assert.equal(classifyFreshness({ sha256: "abc" }, null, { path: "a.js" }).status, "unreadable");
});

test("checker marks ENOENT as missing", async () => {
  const database = { all: (sql) => sql.includes("files WHERE path") ? [{ path: "gone.js", sha256: "abc" }] : [] };
  const fileService = { readForIndex: async () => { const error = new Error("nope"); error.code = "ENOENT"; throw error; } };
  const checker = createIndexFreshnessChecker({ database, fileService });
  assert.deepEqual(await checker.checkPaths(["gone.js"]), [{ path: "gone.js", status: "missing" }]);
});

test("selectFresh demotes stale candidates instead of dropping them", async () => {
  const selector = createRelevantTreeSelector({
    search: { search: () => ({ matches: [] }) },
    fileGraph: { getDependencies: () => ({ edges: [] }), getDependents: () => ({ edges: [] }) },
    freshnessChecker: { checkPaths: async (paths) => paths.map((path) => ({ path, status: path.endsWith("stale.js") ? "stale" : "fresh" })) }
  });
  const result = await selector.selectFresh({
    title: "Work",
    objective: "Update backend/src/stale.js and backend/src/ok.js",
    depth: 0,
    limit: 5
  });
  assert.equal(result.tree.at(-1).path, "backend/src/stale.js");
  assert.equal(result.tree.at(-1).stale, true);
  assert.deepEqual(result.stale_paths, ["backend/src/stale.js"]);
  assert.equal(result.freshness.checked, 2);
});

test("selectFresh falls back to plain select without a checker", async () => {
  const selector = createRelevantTreeSelector({
    search: { search: () => ({ matches: [] }) },
    fileGraph: { getDependencies: () => ({ edges: [] }), getDependents: () => ({ edges: [] }) }
  });
  const result = await selector.selectFresh({ title: "Work", objective: "Update backend/src/ok.js", depth: 0 });
  assert.ok(result.tree.some((entry) => entry.path === "backend/src/ok.js"));
  assert.equal(result.freshness, undefined);
});
