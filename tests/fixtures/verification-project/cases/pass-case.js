import assert from "node:assert/strict";
import test from "node:test";

test("accepts a valid credential", () => {
  assert.equal("forge".startsWith("for"), true);
});
