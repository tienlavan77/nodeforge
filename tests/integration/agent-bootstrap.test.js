import assert from "node:assert/strict";
import test from "node:test";

import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";
import { createAgentBootstrap } from "../../src/modules/agent/agent-bootstrap.js";
import { createAgentRegistry } from "../../src/modules/agent/agent-registry.js";

test("Node bootstrap registers five agents with the shared Bus and is idempotent", () => {
  const registry = createAgentRegistry();
  const bus = { send: () => undefined };
  const architectureManager = {
    createArchitecturePlan: (input) => ({ project_id: input.project_id }),
    createRoadmap: (input) => input,
    createSprintBreakdown: (input) => input
  };
  const sprintLeader = {
    generateTickets: () => [],
    prioritizeBacklog: (tickets) => tickets,
    publishTickets: () => []
  };
  const runtime = {
    startTask: (input) => ({ id: input.taskId, state: "RUNNING" }),
    pauseSession: () => ({ state: "PAUSED" }),
    resumeSession: () => ({ state: "RUNNING" })
  };
  const builder = createBuilderAdapter({ id: "builder-126" });
  const reviewer = createReviewerAdapter({ id: "reviewer-126" });
  const dependencies = { registry, bus, architectureManager, sprintLeader, runtime, builder, reviewer };

  const first = createAgentBootstrap(dependencies);
  const second = createAgentBootstrap(dependencies);

  assert.deepEqual(first.registry.list().map(({ id }) => id), ["architecture-manager", "sprint-leader", "runtime", "builder-126", "reviewer-126"]);
  assert.equal(first.registry.list().length, 5);
  assert.equal(second.registry.list().length, 5);
  assert.equal(first.bus, bus);
  assert.equal(first.registry.get("builder-126").role, "builder");
  assert.equal(first.registry.get("reviewer-126").role, "reviewer");
  assert.equal(first.registry.get("runtime").canHandle({ type: "runtime" }), true);
});

test("bootstrap rejects missing shared dependencies", () => {
  assert.throws(() => createAgentBootstrap({}), /shared Communication Bus/);
});
