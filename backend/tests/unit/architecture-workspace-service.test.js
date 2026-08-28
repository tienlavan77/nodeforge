import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureWorkspaceService } from "../../src/application/architecture-workspace-service.js";

test("returns a deterministic read-only Architecture Workspace projection", () => {
  const decision = { id: "DEC-138", project_id: "PROJECT-138", type: "architecture", title: "Node boundary", decision: "Use Node APIs.", status: "accepted" };
  const knowledge = {
    getArchitecture: () => [decision], getStandards: () => [{ ...decision, id: "STD-138", type: "standard", title: "API only" }],
    getConstraints: () => [{ ...decision, id: "CON-138", type: "constraint", title: "No direct store access" }], getDecisions: () => [decision]
  };
  const service = createArchitectureWorkspaceService({ knowledge });

  const workspace = service.getWorkspace("PROJECT-138");

  assert.equal(workspace.agent.status, "READY");
  assert.equal(workspace.architecture_plan.architecture[0].id, "DEC-138");
  assert.equal(workspace.decisions[0].title, "Node boundary");
  assert.equal(workspace.architecture_plan.standards[0].id, "STD-138");
  assert.equal(workspace.architecture_plan.constraints[0].id, "CON-138");
  workspace.decisions[0].title = "mutated";
  assert.equal(service.getWorkspace("PROJECT-138").decisions[0].title, "Node boundary");
});

test("does not expose another project's roadmap", () => {
  const service = createArchitectureWorkspaceService({
    knowledge: { getArchitecture: () => [], getStandards: () => [], getConstraints: () => [], getDecisions: () => [] }
  });
  assert.deepEqual(service.getWorkspace("PROJECT-138").decisions, []);
});
