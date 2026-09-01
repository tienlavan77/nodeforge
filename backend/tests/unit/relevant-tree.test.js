import assert from "node:assert/strict";
import test from "node:test";
import { createRelevantTreeSelector } from "../../src/modules/index/relevant-tree.js";

test("ranks search seeds and expands bounded graph relations", () => {
  const selector = createRelevantTreeSelector({
    search: { search: ({ query }) => ({ matches: query === "publish" ? [{ score: 1, reason: ["symbol_exact:publish"], node: { path: "src/publisher.js", index_version: "IDX-1" } }] : [] }) },
    fileGraph: { getDependencies: () => ({ edges: [{ from: "src/publisher.js", to: "src/events.js", kind: "dependency" }] }), getDependents: () => ({ edges: [] }) },
    maxFiles: 10
  });
  const result = selector.select({ title: "Publish notification", objective: "publish", depth: 1 });
  assert.deepEqual(result.tree.map((entry) => entry.path), ["src/publisher.js", "src/events.js"]);
  assert.match(result.tree[1].reason[0], /graph:dependency/);
});

test("rejects empty task context and invalid bounds", () => {
  const selector = createRelevantTreeSelector({ search: { search: () => ({ matches: [] }) }, fileGraph: { getDependencies: () => ({ edges: [] }), getDependents: () => ({ edges: [] }) } });
  assert.throws(() => selector.select(), /requires ticket/);
  assert.throws(() => selector.select({ title: "x", depth: 4 }), /between 0 and 3/);
});

test("uses Unicode terms and excludes shared stop words", () => {
  const queries = [];
  const selector = createRelevantTreeSelector({
    search: { search: ({ query }) => { queries.push(query); return { matches: [] }; } },
    fileGraph: { getDependencies: () => ({ edges: [] }), getDependents: () => ({ edges: [] }) }
  });
  selector.select({ title: "Hiển thị trạng thái và UI trong ticket" });
  assert.deepEqual(queries, ["hiển", "thị", "trạng", "thái", "ui", "ticket"]);
});


test("filters by scope before limiting candidates", () => {
  const selector = createRelevantTreeSelector({
    search: { search: () => ({ matches: [
      { score: 9, node: { path: "backend/src/unrelated.js" } },
      { score: 2, node: { path: "ui/nextjs/app/page-agent.jsx" } },
      { score: 1, node: { path: "ui/nextjs/app/NodeForgeApp.jsx" } }
    ] }) },
    fileGraph: { getDependencies: () => ({ edges: [] }), getDependents: () => ({ edges: [] }) }
  });
  const result = selector.select({ title: "Agent Profile page", scope: "ui", allowed_prefixes: ["ui/nextjs/"], limit: 2 });
  assert.deepEqual(result.tree.map((entry) => entry.path), ["ui/nextjs/app/page-agent.jsx", "ui/nextjs/app/NodeForgeApp.jsx"]);
  assert.equal(result.scope, "ui");
});
