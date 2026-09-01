import assert from "node:assert/strict";
import test from "node:test";
import { filterCriteriaForRole } from "../../src/modules/workflows/criteria-filter.js";

test("filters verification criteria for coder", () => {
  assert.deepEqual(filterCriteriaForRole(["Create the page", "Build succeeds", "Kiểm tra empty state"], "coder"), ["Create the page"]);
});

test("preserves all criteria for verification roles", () => {
  const criteria = ["Build succeeds", "Implementation is complete"];
  assert.deepEqual(filterCriteriaForRole(criteria, "tester"), criteria);
  assert.deepEqual(filterCriteriaForRole(criteria, "reviewer"), criteria);
});

test("rejects malformed criteria", () => {
  assert.throws(() => filterCriteriaForRole("Build succeeds"), /array/);
  assert.throws(() => filterCriteriaForRole([""], "coder"), /non-empty/);
});
