import assert from "node:assert/strict";
import test from "node:test";
import { requestedSubmissionFormat, resolveSubmissionFormat } from "../../src/modules/workflows/submission-format.js";

test("normalizes canonical formats and aliases", () => {
  assert.equal(resolveSubmissionFormat("full"), "full_content");
  assert.equal(resolveSubmissionFormat("full_content"), "full_content");
  assert.equal(resolveSubmissionFormat("unified_diff"), "unified_diff");
  assert.equal(resolveSubmissionFormat("patch"), "apply_patch");
  assert.equal(resolveSubmissionFormat("apply_patch"), "apply_patch");
});

test("resolves format from request context and rejects unknown values", () => {
  assert.equal(requestedSubmissionFormat({ expected_submission: { representation: "unified_diff" } }), "unified_diff");
  assert.equal(requestedSubmissionFormat({}), "full_content");
  assert.equal(resolveSubmissionFormat("diff"), "unified_diff");
});
