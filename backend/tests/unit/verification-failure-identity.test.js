// Protects regression attribution from prompt dumps while keeping distinct predicates and incomplete receipts blocking.
import assert from "node:assert/strict";
import test from "node:test";
import { regressionFailureIdentity } from "../../src/modules/supervisor/ticket-verification-regression.js";

// Builds the structured receipt emitted by the actual Node test reporter for a failed regex contract check.
function failure(actual = "unrelated prompt text") {
  return { type: "failure", name: "the required contract", file: "/tmp/run/test.js", line: 10, column: 1,
    error: { name: "AssertionError", code: "ERR_ASSERTION", operator: "match",
      expected: { type: "RegExp", source: "required phrase", flags: "i" }, actual, message: `Input did not match: ${actual}` } };
}

// Computes the production identity from complete reporter output rather than invoking a test-only normalizer.
function identity(event, root = "/tmp/run") {
  return regressionFailureIdentity({ test_paths: ["test.js"] }, { exit_code: 1,
    stdout_redacted: [event, { type: "summary", failed: 1, cancelled: 0 }].map((entry) => JSON.stringify(entry)).join("\n") }, root);
}

test("matching failed regex predicates ignore dumped prose and temporary archive roots", () => {
  const baseline = failure("baseline prompt with query_review");
  const current = failure("new comment guidance with query_review");
  current.file = "/tmp/current/test.js";
  assert.equal(identity(baseline), identity(current, "/tmp/current"));
});

test("different assertion contract, location, test identity, value type or failure remains distinct", () => {
  const original = failure();
  const variants = [
    { ...original, name: "another test" }, { ...original, file: "/tmp/run/other.js" },
    { ...original, line: 11 }, { ...original, column: 2 },
    { ...original, error: { ...original.error, expected: { type: "RegExp", source: "another phrase", flags: "i" } } },
    { ...original, error: { ...original.error, expected: { ...original.error.expected, flags: "" } } },
    { ...original, error: { ...original.error, actual: 42 } },
    { ...original, error: { ...original.error, actual: "required phrase" } },
    { ...original, error: { ...original.error, operator: "strictEqual" } },
    { ...original, error: { ...original.error, code: "OTHER_ERROR" } }
  ];
  for (const event of variants) assert.notEqual(identity(original), identity(event));
});

test("legacy regex serialization and incomplete locations retain strict diagnostic comparison", () => {
  for (const overrides of [{ expected: {} }, { expected: { type: "RegExp", source: "[", flags: "" } }, { operator: "deepStrictEqual" }]) {
    const first = failure("first"); first.error = { ...first.error, ...overrides };
    const second = failure("second"); second.error = { ...second.error, ...overrides };
    assert.notEqual(identity(first), identity(second));
  }
  const first = failure("first"); delete first.line;
  const second = failure("second"); delete second.line;
  assert.notEqual(identity(first), identity(second));
});

test("missing failure records and infrastructure failures never become accepted identities", () => {
  const event = failure();
  const output = { exit_code: 1, stdout_redacted: [event, { type: "summary", failed: 2, cancelled: 0 }].map(JSON.stringify).join("\n") };
  assert.equal(regressionFailureIdentity({ test_paths: ["test.js"] }, output, "/tmp/run"), null);
  assert.equal(identity(failure("ENOSPC no space left on device")), null);
});
