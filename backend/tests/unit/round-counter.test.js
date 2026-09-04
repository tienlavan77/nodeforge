import assert from "node:assert/strict";
import test from "node:test";
import { createRoundCounter } from "../../src/modules/workflows/round-counter.js";

test("round counter allows through the configured limit and rejects the next request", () => {
  const counter = createRoundCounter({ maxRounds: 2 });
  assert.equal(counter.increment("TASK-1").allowed, true);
  assert.equal(counter.increment("TASK-1").allowed, true);
  assert.equal(counter.increment("TASK-1").allowed, false);
  assert.equal(counter.get("TASK-1"), 3);
  counter.reset("TASK-1");
  assert.equal(counter.get("TASK-1"), 0);
});
