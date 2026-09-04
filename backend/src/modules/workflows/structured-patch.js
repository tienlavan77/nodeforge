import { ConfigurationError } from "../../shared/errors.js";

/** Inspect every operation in memory; failed operations leave the source unchanged. */
export function inspectStructuredPatch(original, patch) {
  if (!patch || typeof patch !== "object" || !Array.isArray(patch.operations) || patch.operations.length === 0) throw new ConfigurationError("structured_patch requires a non-empty operations array.");
  let source = String(original).replaceAll("\r\n", "\n");
  const validOperations = [];
  const invalidOperations = [];
  for (const [index, operation] of patch.operations.entries()) {
    try {
      source = applyOperation(source, operation, index);
      validOperations.push({ operation_index: index, op: operation?.op, status: "valid" });
    } catch (error) {
      invalidOperations.push({ operation_index: index, op: operation?.op ?? null, status: "invalid", code: error.code ?? "STRUCTURED_PATCH_INVALID", message: error.message });
    }
  }
  return { success: invalidOperations.length === 0, content: source, valid_operations: validOperations, invalid_operations: invalidOperations };
}

/** Apply deterministic content-based operations without touching the filesystem. */
export function applyStructuredPatch(original, patch) {
  const inspected = inspectStructuredPatch(original, patch);
  if (inspected.invalid_operations.length) {
    const first = inspected.invalid_operations[0];
    const error = new ConfigurationError(first.message);
    error.code = first.code;
    throw error;
  }
  return inspected.content;
}

function applyOperation(source, operation, index) {
  if (!operation || typeof operation.op !== "string") throw patchError(index, "operation requires op");
  if (operation.op === "replace_range" || operation.op === "delete_range") {
    const expected = requireText(operation.expected_content, index, "expected_content");
    const location = locateUnique(source, expected, index, "expected_content");
    const replacement = operation.op === "replace_range" ? requireText(operation.new_content, index, "new_content") : "";
    return source.slice(0, location) + replacement + source.slice(location + expected.length);
  }
  if (operation.op === "insert_after") {
    const anchor = requireText(operation.anchor_text, index, "anchor_text");
    const location = locateUnique(source, anchor, index, "anchor_text");
    const content = requireText(operation.new_content, index, "new_content");
    const end = location + anchor.length;
    return source.slice(0, end) + content + source.slice(end);
  }
  if (operation.op === "insert_at_end") return source + requireText(operation.new_content, index, "new_content");
  throw patchError(index, `unsupported operation: ${operation.op}`);
}

function requireText(value, index, field) { if (typeof value !== "string") throw patchError(index, `${field} is required`); return value; }
function locateUnique(source, needle, index, field) {
  const first = source.indexOf(needle);
  if (first < 0) throw patchError(index, `${field} was not found in the source`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw patchError(index, `${field} must match exactly one source region`);
  return first;
}
function patchError(index, message) { const error = new ConfigurationError(`structured_patch operation ${index}: ${message}.`); error.code = "STRUCTURED_PATCH_INVALID"; return error; }
