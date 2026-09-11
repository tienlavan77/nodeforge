import assert from "node:assert/strict";
import test from "node:test";

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
  const coder = { id: "coder-126", name: "Coder Agent", canHandle: () => true, execute: async () => ({ status: "completed" }) };
  const reviewer = { id: "reviewer-126", name: "Reviewer Agent", canHandle: (task) => task?.type === "review", execute: async () => ({ status: "approved" }) };
  const dependencies = { registry, bus, architectureManager, architectureManagerId: "architecture-126", sprintLeader, sprintLeaderId: "sprint-126", runtime, coder, reviewer };

  const first = createAgentBootstrap(dependencies);
  const second = createAgentBootstrap(dependencies);

  assert.equal(first.registry.list().length, 7);
  assert.equal(second.registry.list().length, 5);
  assert.equal(first.bus, bus);
  assert.equal(first.registry.get("coder-126").role, "coder");
  assert.equal(first.registry.get("reviewer-126").role, "reviewer");
  assert.equal(first.registry.get("runtime").canHandle({ type: "runtime" }), true);
});

test("bootstrap rejects missing shared dependencies", () => {
  assert.throws(() => createAgentBootstrap({}), /shared Communication Bus/);
});
