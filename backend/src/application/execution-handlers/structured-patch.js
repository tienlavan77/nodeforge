import { readFile, writeFile } from "node:fs/promises";
import { backupFile as createBackup } from "./backup.js";
import { createExecutionResult } from "../execution-layer.js";

export async function applyStructuredPatch(filePath, operations, options = {}) {
  const startedAt = Date.now();
  const dryRun = options?.dry_run === true;
  let original;
  try { original = await readFile(filePath, "utf8"); } catch (error) { return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message }); }
  if (!Array.isArray(operations)) return result({ success: false, errorCode: "PATCH_NOT_APPLICABLE", errorMessage: "operations must be an array." });

  const trailingNewline = original.endsWith("\n");
  const lines = splitLines(original);
  const validationError = validateOperations(operations, lines.length);
  if (validationError) return result({ success: false, errorCode: "PATCH_NOT_APPLICABLE", errorMessage: validationError.message, detail: validationError.detail });

  const updatedLines = [...lines];
  const indexed = operations.map((operation, index) => ({ operation, index })).sort((a, b) => operationLine(b.operation) - operationLine(a.operation) || b.index - a.index);
  for (const { operation } of indexed) applyOperation(updatedLines, operation);
  const updated = joinLines(updatedLines, trailingNewline);
  if (dryRun) return result({ success: true, detail: { file_path: filePath, dry_run: true, content: updated, operation_count: operations.length } });

  const backup = await (options?.backupFile ?? ((path) => createBackup(path, { fileService: options?.fileService })))(filePath);
  if (!backup?.success) return backup;
  try { if (options?.fileService?.atomicWrite) await options.fileService.atomicWrite({ path: filePath, content: updated, replace: true }); else await writeFile(filePath, updated, "utf8"); return result({ success: true, detail: { file_path: filePath, backup_ref: backup.detail?.backup_ref, operation_count: operations.length } }); } catch (error) { return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message, detail: { backup_ref: backup.detail?.backup_ref } }); }

  function result(values) { return createExecutionResult({ stepName: "applyStructuredPatch", durationMs: Date.now() - startedAt, ...values }); }
}

function validateOperations(operations, lineCount) {
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== "object") return invalid(index, "operation must be an object");
    if (operation.type === "replace_lines") {
      if (!Number.isInteger(operation.start) || !Number.isInteger(operation.end) || operation.start < 1 || operation.end < operation.start || operation.end > lineCount) return invalid(index, `replace_lines range ${operation.start}-${operation.end} is outside 1-${lineCount}`);
      if (typeof operation.new_content !== "string") return invalid(index, "replace_lines new_content must be a string");
    } else if (operation.type === "insert_after_line") {
      if (!Number.isInteger(operation.line) || operation.line < 1 || operation.line > lineCount) return invalid(index, `insert_after_line line ${operation.line} is outside 1-${lineCount}`);
      if (typeof operation.content !== "string") return invalid(index, "insert_after_line content must be a string");
    } else return invalid(index, `unsupported operation type: ${operation.type ?? "<missing>"}`);
  }
  return null;
}

function invalid(index, message) { return { message: `Invalid operation ${index}: ${message}`, detail: { operation_index: index } }; }
function operationLine(operation) { return operation.type === "replace_lines" ? operation.start : operation.line; }
function applyOperation(lines, operation) {
  if (operation.type === "replace_lines") lines.splice(operation.start - 1, operation.end - operation.start + 1, ...splitLines(operation.new_content));
  else lines.splice(operation.line, 0, ...splitLines(operation.content));
}
function splitLines(content) { const lines = content.replaceAll("\r\n", "\n").split("\n"); if (lines.at(-1) === "") lines.pop(); return lines; }
function joinLines(lines, trailingNewline) { return lines.join("\n") + (trailingNewline ? "\n" : ""); }
