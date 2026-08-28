import assert from "node:assert/strict";
import test from "node:test";

test("rejects an invalid credential", () => {
  assert.equal("invalid", "valid");
});
