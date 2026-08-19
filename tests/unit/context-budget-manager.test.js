import assert from "node:assert/strict";
import test from "node:test";

import { createContextBudgetManager } from "../../src/modules/agent/context-budget-manager.js";

const facts = Array.from({ length: 10 }, (_, index) => `Fact ${index + 1}`);

test("limits facts to the configured context budget while retaining priority order", () => {
  const result = createContextBudgetManager().selectFacts({ facts, maxFacts: 3 });
  assert.deepEqual(result, ["Fact 1", "Fact 2", "Fact 3"]);
});

test("returns deterministic results without modifying the source facts", () => {
  const manager = createContextBudgetManager();
  assert.deepEqual(manager.selectFacts({ facts, maxFacts: 5 }), manager.selectFacts({ facts: [...facts], maxFacts: 5 }));
  assert.equal(facts.length, 10);
});

test("accepts an empty budget and rejects invalid inputs", () => {
  const manager = createContextBudgetManager();
  assert.deepEqual(manager.selectFacts({ facts, maxFacts: 0 }), []);
  assert.throws(() => manager.selectFacts({ facts: ["Fact"], maxFacts: -1 }), /non-negative integer/);
  assert.throws(() => manager.selectFacts({ facts: [1], maxFacts: 1 }), /array of strings/);
});
