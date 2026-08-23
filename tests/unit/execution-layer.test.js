import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionContext, createExecutionResult, evaluateApplyResult, logExecutionTrace, withExecutionResult } from "../../src/application/execution-layer.js";

test("pipes immutable execution context and accumulates trace", () => {
  const context = createExecutionContext({ taskId: "T", stepId: 1, change: { file_path: "src/a.js" } });
  const next = withExecutionResult(context, { stepName: "apply", success: true });
  assert.deepEqual(context.trace, []);
  assert.equal(next.trace[0].step_name, "apply");
});

test("routes every execution error code deterministically", () => {
  assert.equal(evaluateApplyResult(createExecutionResult({ stepName: "apply", success: true })), "commit");
  for (const code of ["IO_ERROR", "CHECKSUM_MISMATCH", "LINT_FAILED", "TEST_FAILED", "BUILD_FAILED"]) assert.equal(evaluateApplyResult(createExecutionResult({ stepName: "x", success: false, errorCode: code })), "rollback");
  for (const code of ["AMBIGUOUS_MATCH", "NO_MATCH", "PATCH_NOT_APPLICABLE", "SYNTAX_ERROR"]) assert.equal(evaluateApplyResult(createExecutionResult({ stepName: "x", success: false, errorCode: code })), "retry");
});

test("trace logger receives only the normalized trace", () => {
  const logs = [];
  const context = withExecutionResult(createExecutionContext({ taskId: "T", stepId: 1, change: {} }), { stepName: "write", success: false, errorCode: "IO_ERROR" });
  logExecutionTrace(context, { info: (_message, payload) => logs.push(payload) });
  assert.equal(logs[0].trace[0].error_code, "IO_ERROR");
});
