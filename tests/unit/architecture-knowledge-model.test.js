import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";

test("builds deterministic architecture, standards, constraints, and decisions views", () => {
  const store = createArchitectureDecisionStore();
  store.append(decision("DECISION-114-1", "architecture", "Node is the governance source of truth."));
  store.append(decision("DECISION-114-2", "standard", "All agent communication goes through Node."));
  store.append(decision("DECISION-114-3", "constraint", "Agents receive context from Node."));
  const model = createArchitectureKnowledgeModel({ decisions: store });

  assert.deepEqual(model.getArchitecture().map(({ id, decision }) => ({ id, decision })), [{ id: "DECISION-114-1", decision: "Node is the governance source of truth." }]);
  assert.deepEqual(model.getStandards().map(({ id }) => id), ["DECISION-114-2"]);
  assert.deepEqual(model.getConstraints().map(({ id }) => id), ["DECISION-114-3"]);
  assert.deepEqual(model.getDecisions().map(({ id }) => id), ["DECISION-114-1", "DECISION-114-2", "DECISION-114-3"]);
  assert.deepEqual(model.getDecisions(), model.getDecisions());
});

test("does not mutate source Decisions or expose mutable model state", () => {
  const store = createArchitectureDecisionStore();
  store.append(decision("DECISION-114-4", "architecture", "Use a canonical knowledge model."));
  const model = createArchitectureKnowledgeModel({ decisions: store });
  const view = model.getArchitecture();
  view[0].title = "mutated view";

  assert.equal(store.getById("DECISION-114-4").title, "Decision DECISION-114-4");
  assert.equal(model.getArchitecture()[0].title, "Decision DECISION-114-4");
});

function decision(id, type, value) {
  return {
    id,
    project_id: "PROJECT-114",
    type,
    title: `Decision ${id}`,
    decision: value,
    status: "accepted",
    created_at: "2026-08-20T08:00:00Z"
  };
}
