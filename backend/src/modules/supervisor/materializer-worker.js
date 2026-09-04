import { inspectStructuredPatch } from "../workflows/structured-patch.js";
import { resolveSubmissionFormat } from "../workflows/submission-format.js";

export function createMaterializerWorker({ fileService, applyPatchHandlers = {} } = {}) {
  return Object.freeze({ materialize });
  async function materialize({ task_id, supervisor_id, request_id, correlation_id, attempt = 1, files = [] } = {}) {
    const valid_patches = []; const invalid_patches = [];
    for (const [index, file] of files.entries()) {
      const patch = { patch_id: file.patch_id ?? `PATCH-${index + 1}`, path: file.path, format: resolveSubmissionFormat(file.format) };
      try {
        let content = file.content;
        if (patch.format === "structured_patch") {
          const original = await fileService.readFile({ path: file.path });
          const inspected = inspectStructuredPatch(original, file.content);
          if (inspected.invalid_operations.length) {
            invalid_patches.push({ ...patch, status: "invalid", file_result: "rejected", errors: inspected.invalid_operations });
            continue;
          }
          content = inspected.content;
          valid_patches.push({ ...patch, status: "valid", file_result: "materialized", operations: inspected.valid_operations, content });
        } else if (patch.format !== "full_content") {
          const handler = applyPatchHandlers[patch.format];
          const result = await handler?.(file);
          if (!result?.success || typeof result.content !== "string") throw new Error(`Unable to materialize ${patch.format}.`);
          content = result.content;
        }
        if (patch.format !== "structured_patch") valid_patches.push({ ...patch, status: "valid", file_result: "materialized", content });
      } catch (error) {
        invalid_patches.push({ ...patch, status: "invalid", file_result: "rejected", error: { operation_index: 0, status: "invalid", code: error.code ?? "PATCH_NOT_APPLICABLE", message: error.message } });
      }
    }
    return { task_id, supervisor_id, request_id, correlation_id, attempt, filesystem_write: false, valid_patches, invalid_patches };
  }
}
