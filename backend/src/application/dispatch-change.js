import { withExecutionResult, createExecutionResult } from "./execution-layer.js";
import { verifyChecksum } from "./execution-handlers/verify-checksum.js";
import { applySearchReplaceBlock } from "./execution-handlers/search-replace.js";
import { applyFullFileReplace } from "./execution-handlers/full-file-replace.js";
import { applyUnifiedDiff } from "./execution-handlers/unified-diff.js";
import { applyStructuredPatch } from "./execution-handlers/structured-patch.js";
import { applyApplyPatch } from "./execution-handlers/apply-patch.js";
import { logEvent } from "../core/project-log-service.js";

/** Verify a change and dispatch it to exactly one execution handler. */
export async function dispatchChange(context) {
  const change = context?.change;
  const filePath = change?.file_path;
  let next = context;

  const checksum = await verifyChecksum(filePath, change?.checksum_before);
  next = withExecutionResult(next, checksum);
  if (!checksum.success) return next;

  console.log(`[dispatch-change] input ${JSON.stringify({
    file_path: filePath,
    fields: change && typeof change === "object" ? Object.keys(change).filter((key) => key !== "checksum_before") : [],
    has_diff: typeof change?.diff === "string",
    has_content: typeof change?.content === "string",
    has_search_replace: typeof change?.old_str === "string" && typeof change?.new_str === "string",
    has_operations: Array.isArray(change?.operations),
    content_chars: typeof (change?.diff ?? change?.content) === "string" ? (change.diff ?? change.content).length : null,
    content_preview: typeof (change?.diff ?? change?.content) === "string" ? (change.diff ?? change.content).slice(0, 300) : null
  })}`);

  // Route the Codex apply_patch envelope to its dedicated context-based parser.
  if (typeof change?.diff === "string" && /^\s*\*\*\* Begin Patch\b/.test(change.diff)) {
    const result = await applyApplyPatch(filePath, change.diff, { fileService: context.file_service });
    const completed = withExecutionResult(next, result);
    logEvent({ timestamp: new Date().toISOString(), event_name: "execution.dispatch_result", level: result.success ? "info" : "error", status: result.success ? "success" : "failed", message: result.success ? "apply_patch dispatched successfully." : result.error_message, task_id: context.task_id, ticket_id: context.ticket_id ?? context.task_id, conversation_id: context.conversation_id ?? `CONV-${context.task_id}`, source: "dispatch-change", error_code: result.error_code });
    return completed;
  }

  let result;
  if (typeof change.diff === "string" && /(^|\n)---[^\n]*\n\+\+\+/m.test(change.diff)) {
    result = await applyUnifiedDiff(filePath, change.diff, { fileService: context.file_service });
  } else if (typeof change.old_str === "string" && typeof change.new_str === "string") {
    result = await applySearchReplaceBlock(filePath, change.old_str, change.new_str, { fileService: context.file_service });
  } else if (Array.isArray(change.operations)) {
    result = await applyStructuredPatch(filePath, change.operations, { fileService: context.file_service });
  } else if (typeof change.content === "string") {
    result = await applyFullFileReplace(filePath, change.content, { fileService: context.file_service });
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
