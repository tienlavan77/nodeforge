import { withExecutionResult, createExecutionResult } from "./execution-layer.js";
import { verifyChecksum } from "./execution-handlers/verify-checksum.js";
import { applySearchReplaceBlock } from "./execution-handlers/search-replace.js";
import { applyFullFileReplace } from "./execution-handlers/full-file-replace.js";
import { applyUnifiedDiff } from "./execution-handlers/unified-diff.js";
import { applyStructuredPatch } from "./execution-handlers/structured-patch.js";
import { logEvent } from "../core/project-log-service.js";

/** Verify a change and dispatch it to exactly one execution handler. */
export async function dispatchChange(context) {
  const change = context?.change;
  const filePath = change?.file_path;
  let next = context;

  const checksum = await verifyChecksum(filePath, change?.checksum_before);
  next = withExecutionResult(next, checksum);
  if (!checksum.success) return next;

  let result;
  if (typeof change.diff === "string" && /(^|\n)---[^\n]*\n\+\+\+/m.test(change.diff)) {
    result = await applyUnifiedDiff(filePath, change.diff);
  } else if (typeof change.old_str === "string" && typeof change.new_str === "string") {
    result = await applySearchReplaceBlock(filePath, change.old_str, change.new_str);
  } else if (Array.isArray(change.operations)) {
    result = await applyStructuredPatch(filePath, change.operations);
  } else if (typeof change.content === "string") {
    result = await applyFullFileReplace(filePath, change.content);
  } else {
    result = createExecutionResult({
      stepName: "dispatchChange",
      success: false,
      errorCode: "PATCH_NOT_APPLICABLE",
      errorMessage: "Change does not contain a supported patch format."
    });
  }
  const completed = withExecutionResult(next, result);
  logEvent({ timestamp: new Date().toISOString(), event_name: "execution.dispatch_result", level: result.success ? "info" : "error", status: result.success ? "success" : "failed", message: result.success ? "Change dispatched successfully." : "Change dispatch failed.", task_id: context.task_id, ticket_id: context.ticket_id ?? context.task_id, conversation_id: context.conversation_id ?? `CONV-${context.task_id}`, source: "dispatch-change" });
  return completed;
}
