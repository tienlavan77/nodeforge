// validated by FORGE-VALIDATE-002
// validated by FORGE-VALIDATE-003
// validated by FORGE-VALIDATE-002
// validated by FORGE-VALIDATE-001G
import { ConfigurationError } from "../shared/errors.js";

export const EXECUTION_ERROR_CODES = Object.freeze(["CHECKSUM_MISMATCH", "PATCH_NOT_APPLICABLE", "AMBIGUOUS_MATCH", "NO_MATCH", "SYNTAX_ERROR", "LINT_FAILED", "TEST_FAILED", "BUILD_FAILED", "IO_ERROR"]);

export function createExecutionResult({ stepName, success, errorCode = null, errorMessage = null, detail, durationMs } = {}) {
  if (typeof stepName !== "string" || !stepName) throw new ConfigurationError("ExecutionResult step_name is required.");
  if (typeof success !== "boolean") throw new ConfigurationError("ExecutionResult success is required.");
  if (success && errorCode !== null) throw new ConfigurationError("Successful execution must have error_code null.");
  if (!success && !EXECUTION_ERROR_CODES.includes(errorCode)) throw new ConfigurationError(`Unknown execution error code: ${errorCode}`);
  return Object.freeze({ step_name: stepName, success, error_code: errorCode, ...(errorMessage !== null ? { error_message: errorMessage } : {}), ...(detail ? { detail: structuredClone(detail) } : {}), ...(durationMs !== undefined ? { duration_ms: durationMs } : {}) });
}

export function createExecutionContext({ taskId, stepId, change, trace = [], eventSink } = {}) {
  if (typeof taskId !== "string" || !taskId || !Number.isFinite(stepId) || !change || typeof change !== "object") throw new ConfigurationError("ExecutionContext requires task_id, step_id, and change.");
  const context = { task_id: taskId, step_id: stepId, change: structuredClone(change), trace: trace.map((result) => createExecutionResult({ stepName: result.step_name, success: result.success, errorCode: result.error_code, errorMessage: result.error_message ?? null, detail: result.detail, durationMs: result.duration_ms })) };
  if (eventSink !== undefined) {
    if (typeof eventSink !== "function") throw new ConfigurationError("ExecutionContext event_sink must be a function.");
    Object.defineProperty(context, "event_sink", { value: eventSink, enumerable: false });
  }
  return Object.freeze(context);
}

export function withExecutionResult(context, result) {
  const normalized = createExecutionResult({
    stepName: result?.step_name ?? result?.stepName,
    success: result?.success,
    errorCode: result?.error_code ?? result?.errorCode ?? null,
    errorMessage: result?.error_message ?? result?.errorMessage ?? null,
    detail: result?.detail,
    durationMs: result?.duration_ms ?? result?.durationMs
  });
  context.event_sink?.({ event_type: "node.execution_step", task_id: context.task_id, timestamp: new Date().toISOString(), sequence: context.trace.length + 1, payload: { result: normalized, step_id: context.step_id } });
  return createExecutionContext({ taskId: context.task_id, stepId: context.step_id, change: context.change, trace: [...context.trace, normalized], eventSink: context.event_sink });
}

export function evaluateApplyResult(result) {
  if (result?.success) return "commit";
  if (result?.error_code === "IO_ERROR" || result?.error_code === "CHECKSUM_MISMATCH") return "rollback";
  if (["AMBIGUOUS_MATCH", "NO_MATCH", "PATCH_NOT_APPLICABLE", "SYNTAX_ERROR"].includes(result?.error_code)) return "retry";
  if (["LINT_FAILED", "TEST_FAILED", "BUILD_FAILED"].includes(result?.error_code)) return "rollback";
  throw new ConfigurationError("Cannot evaluate an unknown ExecutionResult.");
}

export function logExecutionTrace(context, logger = console) {
  logger.info?.("Execution trace", { task_id: context.task_id, step_id: context.step_id, trace: context.trace });
  return context.trace;
}
