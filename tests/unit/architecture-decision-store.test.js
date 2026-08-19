import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";

test("stores valid Architecture Decisions append-only in insertion order", () => {
  const store = createArchitectureDecisionStore();
  const first = decision("DECISION-113-1", "architecture");
  const second = decision("DECISION-113-2", "standard");
  store.append(first);
  store.append(second);
  first.title = "mutated by caller";

  assert.deepEqual(store.getAll().map(({ id }) => id), ["DECISION-113-1", "DECISION-113-2"]);
  assert.equal(store.getById("DECISION-113-1").title, "Decision DECISION-113-1");
  assert.deepEqual(store.getByType("architecture").map(({ id }) => id), ["DECISION-113-1"]);
  assert.throws(() => store.append(second), /already exists/);
});

test("rejects Architecture Decisions that violate the governance contract", () => {
  const store = createArchitectureDecisionStore();
  const invalid = decision("DECISION-113-invalid", "architecture");
  delete invalid.type;
  assert.throws(() => store.append(invalid), /Invalid Architecture Decision/);
  assert.equal(store.getAll().length, 0);
});

function decision(id, type) {
  return {
    id,
    project_id: "PROJECT-113",
    type,
    title: `Decision ${id}`,
    decision: "Use Node as the governance source of truth.",
    status: "accepted",
    created_at: "2026-08-20T07:00:00Z"
  };
}
