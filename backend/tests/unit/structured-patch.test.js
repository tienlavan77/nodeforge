import assert from "node:assert/strict";
import test from "node:test";
import { applyStructuredPatch, inspectStructuredPatch } from "../../src/modules/workflows/structured-patch.js";

test("replaces exact content without line coordinates", () => {
  const result = applyStructuredPatch("one\ntwo\nthree\n", { operations: [{ op: "replace_range", expected_content: "two", new_content: "TWO" }] });
  assert.equal(result, "one\nTWO\nthree\n");
});

test("applies sequential content operations", () => {
  const result = applyStructuredPatch("one\ntwo\nthree\n", { operations: [
    { op: "replace_range", expected_content: "two", new_content: "two-a\ntwo-b" },
    { op: "insert_after", anchor_text: "three", new_content: "\nfour" },
    { op: "insert_at_end", new_content: "\nfive" }
  ] });
  assert.equal(result, "one\ntwo-a\ntwo-b\nthree\nfour\n\nfive");
});

test("rejects missing, stale, and ambiguous source context", () => {
  assert.throws(() => applyStructuredPatch("one\ntwo\n", { operations: [{ op: "replace_range", new_content: "x" }] }), /expected_content is required/);
  assert.throws(() => applyStructuredPatch("one\ntwo\n", { operations: [{ op: "replace_range", expected_content: "stale", new_content: "x" }] }), /expected_content was not found/);
  assert.throws(() => applyStructuredPatch("same\nother\nsame\n", { operations: [{ op: "insert_after", anchor_text: "same", new_content: "x" }] }), /anchor_text must match exactly one/);
});


test("inspects every operation and reports valid and invalid patches", () => {
  const result = inspectStructuredPatch("one\ntwo\n", { operations: [
    { op: "replace_range", expected_content: "one", new_content: "ONE" },
    { op: "insert_after", anchor_text: "missing", new_content: "x" },
    { op: "insert_after", anchor_text: "two", new_content: "!" }
  ] });
  assert.equal(result.success, false);
  assert.deepEqual(result.valid_operations.map(({ operation_index }) => operation_index), [0, 2]);
  assert.deepEqual(result.invalid_operations.map(({ operation_index }) => operation_index), [1]);
  assert.equal(result.content, "ONE\ntwo!\n");
});
