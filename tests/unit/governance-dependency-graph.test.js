import assert from "node:assert/strict";
import test from "node:test";

import { createGovernanceDependencyGraph } from "../../src/modules/governance/governance-dependency-graph.js";

test("manages Governance dependencies and returns a deterministic execution order", () => {
  const graph = createGovernanceDependencyGraph();
  graph.addNode({ id: "ROADMAP-117", type: "roadmap" });
  graph.addNode({ id: "SPRINT-117", type: "sprint" });
  graph.addNode({ id: "TICKET-117", type: "ticket" });
  graph.addNode({ id: "COMMIT-117", type: "commit" });
  graph.addDependency("SPRINT-117", "ROADMAP-117");
  graph.addDependency("TICKET-117", "SPRINT-117");
  graph.addDependency("COMMIT-117", "TICKET-117");

  assert.deepEqual(graph.getDependencies("TICKET-117").map(({ id }) => id), ["SPRINT-117"]);
  assert.deepEqual(graph.getDependents("SPRINT-117").map(({ id }) => id), ["TICKET-117"]);
  assert.deepEqual(graph.getExecutionOrder().map(({ id }) => id), ["ROADMAP-117", "SPRINT-117", "TICKET-117", "COMMIT-117"]);
});

test("rejects dependency cycles and does not expose mutable node state", () => {
  const graph = createGovernanceDependencyGraph();
  graph.addNode({ id: "SPRINT-A", type: "sprint", title: "A" });
  graph.addNode({ id: "SPRINT-B", type: "sprint" });
  graph.addDependency("SPRINT-B", "SPRINT-A");
  assert.throws(() => graph.addDependency("SPRINT-A", "SPRINT-B"), /creates a cycle/);
  const node = graph.getDependencies("SPRINT-B")[0];
  node.title = "mutated";
  assert.equal(graph.getDependencies("SPRINT-B")[0].title, "A");
});
