import { createHash } from "node:crypto";
import { inspectStructuredPatch } from "../workflows/structured-patch.js";
import { resolveSubmissionFormat } from "../workflows/submission-format.js";

const ALLOWED_OPERATION_FIELDS = Object.freeze({
  replace_range: new Set(["op", "expected_content", "new_content"]),
  delete_range: new Set(["op", "expected_content"]),
  insert_after: new Set(["op", "anchor_text", "new_content"]),
  insert_at_end: new Set(["op", "new_content"])
});

export function createMaterializerWorker({ fileService, applyPatchHandlers = {} } = {}) {
  return Object.freeze({ materialize, verify });

  async function materialize(input = {}) {
    const job = normalizeMaterialJob(input);
    const results = [];
    for (const [index, file] of job.files.entries()) {
      results.push(await inspectSubmittedFile(job, file, index));
    }
    results.push(...missingApprovedFiles(job));
    return buildMaterialResult(job, results);
  }

  async function verify(input = {}) {
    const job = normalizeMaterialJob(input);
    const results = [];
    const candidates = Array.isArray(job.valid_patches) && job.valid_patches.length
      ? job.valid_patches.map((patch, index) => patchToFile(patch, index))
      : job.files;
    for (const [index, file] of candidates.entries()) {
      results.push(await inspectSubmittedFile(job, file, index));
    }
    if (!candidates.length) results.push(...missingApprovedFiles(job));
    return buildMaterialResult(job, results, {
      source: Array.isArray(job.valid_patches) && job.valid_patches.length ? "valid_patches" : "files"
    });
  }

  function normalizeMaterialJob(input = {}) {
    const payload = input?.payload && typeof input.payload === "object" ? input.payload : {};
    return {
      task_id: input.task_id,
      supervisor_id: input.supervisor_id,
      request_id: input.request_id,
      correlation_id: input.correlation_id,
      attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
      files: Array.isArray(input.files) ? input.files : (Array.isArray(payload.files) ? payload.files : []),
      approved_plan: Array.isArray(input.approved_plan) ? input.approved_plan : (Array.isArray(payload.approved_plan) ? payload.approved_plan : []),
      valid_patches: Array.isArray(input.valid_patches) ? input.valid_patches : (Array.isArray(payload.valid_patches) ? payload.valid_patches : []),
      invalid_patches: Array.isArray(input.invalid_patches) ? input.invalid_patches : (Array.isArray(payload.invalid_patches) ? payload.invalid_patches : []),
      filesystem_write: false
    };
  }

  async function inspectSubmittedFile(job, file, index) {
    const base = {
      patch_id: file?.patch_id ?? `PATCH-${index + 1}`,
      path: file?.path,
      format: safeFormat(file?.format),
      submitted_content: file?.content ?? null,
      before_checksum: file?.before_checksum ?? null,
      current_content: null,
      proposed_content: null,
      after_checksum: null
    };
    const verification = createVerificationFlags();
    try {
      assertPath(base.path);
      verification.structure_ok = true;

      const planItem = job.approved_plan.find((item) => item?.path === base.path);
      if (planItem?.action === "READ_ONLY") {
        throw workerError("READ_ONLY_SUBMISSION_FORBIDDEN", "READ_ONLY files must not be included in submit_code_response.files.");
      }

      if (base.format === "structured_patch") {
        return await inspectStructuredPatchFile(job, file, base, verification, planItem);
      }
      if (base.format === "full_content") {
        return await inspectFullContentFile(job, file, base, verification, planItem);
      }
      return await inspectHandlerPatchFile(file, base, verification, planItem);
    } catch (error) {
      return invalidFileResult(base, verification, [fileError(error, error?.operationIndex ?? 0)]);
    }
  }

  async function inspectStructuredPatchFile(job, file, base, verification, planItem) {
    if (file?.exists !== true) throw workerError("PATCH_STRUCTURE_INVALID", "structured_patch requires exists=true.");
    if (planItem && planItem.action === "NEW") throw workerError("PATCH_STRUCTURE_INVALID", "NEW approved files must use full_content.");
    if (typeof file.before_checksum !== "string") throw workerError("MISSING_BEFORE_CHECKSUM", "MODIFY structured_patch requires before_checksum.");
    const operations = file.content?.operations;
    if (!Array.isArray(operations) || !operations.length) throw workerError("PATCH_STRUCTURE_INVALID", "structured_patch.content.operations must be a non-empty array.");
    validateOperationFields(operations, base.path);
    const current = await readCurrentFile(base.path);
    base.current_content = current;
    const actualChecksum = contentChecksum(current);
    verification.checksum_ok = actualChecksum === file.before_checksum;
    if (!verification.checksum_ok) throw workerError("CHECKSUM_MISMATCH", `Current file checksum does not match before_checksum: ${base.path}.`, { expected: file.before_checksum, actual: actualChecksum });
    const inspected = inspectStructuredPatch(current, file.content);
    verification.anchor_ok = inspected.invalid_operations.length === 0;
    verification.dry_apply_ok = verification.anchor_ok;
    if (!verification.dry_apply_ok) throw operationErrors(inspected.invalid_operations);
    base.proposed_content = inspected.content;
    base.after_checksum = contentChecksum(inspected.content);
    base.exists = true;
    return validFileResult(base, verification, inspected.valid_operations);
  }

  async function inspectFullContentFile(job, file, base, verification, planItem) {
    if (typeof file.content !== "string" || !file.content.length) throw workerError("PATCH_STRUCTURE_INVALID", "full_content requires complete non-empty string content.");
    if (file.exists === false || planItem?.action === "NEW") {
      if (file.before_checksum !== null) throw workerError("INVALID_NEW_FILE_CHECKSUM", "NEW file must use before_checksum=null.");
      if (await fileExists(base.path)) throw workerError("NEW_FILE_ALREADY_EXISTS", `NEW file already exists: ${base.path}.`);
      base.exists = false;
      verification.checksum_ok = true;
      verification.anchor_ok = true;
      verification.dry_apply_ok = true;
      base.proposed_content = file.content;
      base.after_checksum = contentChecksum(file.content);
      return validFileResult(base, verification, []);
    }
    if (planItem && planItem.action === "MODIFY") throw workerError("PATCH_STRUCTURE_INVALID", "MODIFY approved files must return structured_patch.");
    if (typeof file.before_checksum !== "string") throw workerError("MISSING_BEFORE_CHECKSUM", "Existing full_content file requires before_checksum.");
    const current = await readCurrentFile(base.path);
    base.current_content = current;
    const actualChecksum = contentChecksum(current);
    verification.checksum_ok = actualChecksum === file.before_checksum;
    if (!verification.checksum_ok) throw workerError("CHECKSUM_MISMATCH", `Current file checksum does not match before_checksum: ${base.path}.`, { expected: file.before_checksum, actual: actualChecksum });
    verification.anchor_ok = true;
    verification.dry_apply_ok = true;
    base.exists = true;
    base.proposed_content = file.content;
    base.after_checksum = contentChecksum(file.content);
    return validFileResult(base, verification, []);
  }

  async function inspectHandlerPatchFile(file, base, verification) {
    const handler = applyPatchHandlers[base.format];
    if (typeof handler !== "function") throw workerError("SUBMISSION_FORMAT_UNSUPPORTED", `Unsupported submission format: ${base.format}.`);
    if (file.exists !== true) throw workerError("SUBMISSION_FORMAT_UNSUPPORTED", `${base.format} cannot create a file; use full_content.`);
    if (typeof file.before_checksum !== "string") throw workerError("MISSING_BEFORE_CHECKSUM", `${base.format} requires before_checksum.`);
    const current = await readCurrentFile(base.path);
    base.current_content = current;
    const actualChecksum = contentChecksum(current);
    verification.checksum_ok = actualChecksum === file.before_checksum;
    if (!verification.checksum_ok) throw workerError("CHECKSUM_MISMATCH", `Current file checksum does not match before_checksum: ${base.path}.`, { expected: file.before_checksum, actual: actualChecksum });
    const result = await handler(file);
    verification.anchor_ok = Boolean(result?.success);
    verification.dry_apply_ok = Boolean(result?.success && typeof result.content === "string");
    if (!verification.dry_apply_ok) throw workerError(result?.error_code ?? "PATCH_NOT_APPLICABLE", result?.error_message ?? `Unable to materialize ${base.format}.`);
    base.exists = true;
    base.proposed_content = result.content;
    base.after_checksum = contentChecksum(result.content);
    return validFileResult(base, verification, []);
  }

  function validateOperationFields(operations, path) {
    for (const [index, operation] of operations.entries()) {
      if (!operation || typeof operation !== "object") throw workerError("PATCH_STRUCTURE_INVALID", `Operation ${index} must be an object.`, index);
      const allowed = ALLOWED_OPERATION_FIELDS[operation.op];
      if (!allowed) throw workerError("PATCH_STRUCTURE_INVALID", `Unsupported structured_patch operation at ${path}[${index}].`, index);
      const extra = Object.keys(operation).filter((key) => !allowed.has(key));
      if (extra.length) throw workerError("PATCH_STRUCTURE_INVALID", `Operation ${index} at ${path} contains unused fields: ${extra.join(", ")}.`, index);
      for (const field of allowed) {
        if (field === "op") continue;
        if (!(field in operation) || typeof operation[field] !== "string") throw workerError("PATCH_STRUCTURE_INVALID", `Operation ${index} at ${path} requires string ${field}.`, index);
      }
      if ((operation.op === "replace_range" || operation.op === "delete_range") && !operation.expected_content.length) throw workerError("PATCH_STRUCTURE_INVALID", `Operation ${index} at ${path} requires non-empty expected_content.`, index);
      if (operation.op === "insert_after" && !operation.anchor_text.length) throw workerError("PATCH_STRUCTURE_INVALID", `Operation ${index} at ${path} requires non-empty anchor_text.`, index);
      if ((operation.op === "replace_range" || operation.op === "insert_after" || operation.op === "insert_at_end") && !operation.new_content.length) throw workerError("PATCH_STRUCTURE_INVALID", `Operation ${index} at ${path} requires non-empty new_content.`, index);
    }
  }

  function missingApprovedFiles(job) {
    const submittedPaths = new Set(job.files.map((file) => file?.path).filter(Boolean));
    return job.approved_plan
      .filter((item) => (item?.action === "NEW" || item?.action === "MODIFY") && !submittedPaths.has(item.path))
      .map((item) => ({
        patch_id: `MISSING-${item.path}`,
        path: item.path,
        format: "missing_submission",
        exists: item.action !== "NEW",
        before_checksum: item.before_checksum ?? null,
        current_content: null,
        submitted_content: null,
        proposed_content: null,
        after_checksum: null,
        status: "invalid",
        file_result: "rejected",
        verification: { structure_ok: false, checksum_ok: false, anchor_ok: false, dry_apply_ok: false },
        errors: [fileError(workerError("MISSING_SUBMISSION", "Approved file was not submitted by R3."), 0)]
      }));
  }

  function buildMaterialResult(job, results, extra = {}) {
    const valid_patches = [];
    const invalid_patches = [];
    const repair_context = {
      missing_paths: [],
      checksum_mismatch_paths: [],
      anchor_errors: [],
      structure_errors: [],
      dry_apply_errors: [],
      read_only_violations: []
    };
    for (const result of results) {
      if (result.status === "valid") valid_patches.push(result);
      else {
        invalid_patches.push(result);
        collectRepairContext(result, repair_context);
      }
    }
    return {
      task_id: job.task_id,
      supervisor_id: job.supervisor_id,
      request_id: job.request_id,
      correlation_id: job.correlation_id,
      attempt: job.attempt,
      filesystem_write: false,
      status: invalid_patches.length ? "invalid" : (valid_patches.length ? "valid" : "empty"),
      valid: Object.fromEntries(valid_patches.filter((patch) => patch.path).map((patch) => [patch.path, patch])),
      invalid: Object.fromEntries(invalid_patches.filter((patch) => patch.path).map((patch) => [patch.path, patch])),
      valid_patches,
      invalid_patches,
      invalid_count: invalid_patches.length,
      repair_context,
      ...extra
    };
  }

  function collectRepairContext(result, context) {
    const codes = (result.errors ?? []).map((error) => error.code);
    if (codes.includes("MISSING_SUBMISSION")) context.missing_paths.push(result.path);
    if (codes.includes("CHECKSUM_MISMATCH")) context.checksum_mismatch_paths.push(result.path);
    if (codes.includes("READ_ONLY_SUBMISSION_FORBIDDEN")) context.read_only_violations.push(result.path);
    if (codes.some((code) => code === "EXPECTED_CONTENT_NOT_FOUND" || code === "ANCHOR_NOT_FOUND" || code === "AMBIGUOUS_ANCHOR")) {
      context.anchor_errors.push({ path: result.path, errors: result.errors });
    }
    if (codes.some((code) => code === "PATCH_STRUCTURE_INVALID" || code === "INVALID_STRUCTURED_PATCH" || code === "SUBMISSION_FORMAT_UNSUPPORTED" || code === "MISSING_BEFORE_CHECKSUM" || code === "INVALID_NEW_FILE_CHECKSUM" || code === "NEW_FILE_ALREADY_EXISTS" || code === "MODIFY_TARGET_MISSING")) {
      context.structure_errors.push({ path: result.path, errors: result.errors });
    }
    if (codes.includes("PATCH_NOT_APPLICABLE") || result.verification?.dry_apply_ok === false) {
      context.dry_apply_errors.push({ path: result.path, errors: result.errors });
    }
  }

  function validFileResult(base, verification, operations) {
    return {
      ...base,
      status: "valid",
      file_result: "materialized",
      content: base.proposed_content,
      operations,
      verification,
      errors: []
    };
  }

  function invalidFileResult(base, verification, errors) {
    return {
      ...base,
      content: null,
      status: "invalid",
      file_result: "rejected",
      verification,
      errors,
      error: errors[0] ?? null
    };
  }

  function createVerificationFlags() {
    return { structure_ok: false, checksum_ok: false, anchor_ok: false, dry_apply_ok: false };
  }

  async function readCurrentFile(path) {
    if (typeof fileService?.readFile !== "function") throw workerError("IO_ERROR", "File Service readFile is unavailable.");
    try {
      return await fileService.readFile({ path });
    } catch (error) {
      if (error?.code === "ENOENT") throw workerError("MODIFY_TARGET_MISSING", `File does not exist: ${path}.`);
      throw workerError("IO_ERROR", `Cannot read ${path}: ${error.message}`);
    }
  }

  async function fileExists(path) {
    if (typeof fileService?.exists === "function") return Boolean(await fileService.exists({ path }));
    if (typeof fileService?.readFile === "function") {
      try { await fileService.readFile({ path }); return true; }
      catch (error) { if (error?.code === "ENOENT") return false; throw workerError("IO_ERROR", `Cannot inspect ${path}: ${error.message}`); }
    }
    return false;
  }

  function patchToFile(patch, index) {
    return {
      patch_id: patch.patch_id ?? `PATCH-${index + 1}`,
      path: patch.path,
      format: patch.format,
      content: patch.submitted_content ?? patch.content,
      exists: patch.exists ?? patch.format === "structured_patch",
      before_checksum: patch.before_checksum ?? null,
      language: patch.language ?? "text",
      size_bytes: patch.size_bytes ?? 0
    };
  }

  function safeFormat(value) {
    try { return resolveSubmissionFormat(value); }
    catch { return typeof value === "string" ? value : "unknown"; }
  }

  function assertPath(path) {
    if (typeof path !== "string" || !path || path.endsWith("/") || path.split("/").some((segment) => segment === "." || segment === "..")) {
      throw workerError("PATCH_STRUCTURE_INVALID", "Submission file requires a concrete relative path.");
    }
  }

  function contentChecksum(content) {
    return `sha256:${createHash("sha256").update(String(content), "utf8").digest("hex")}`;
  }

  function operationErrors(invalidOperations) {
    const errors = invalidOperations.map((operation) => ({
      ...operation,
      status: "invalid",
      code: structuredPatchCode(operation),
      message: operation.message ?? "structured_patch operation is invalid."
    }));
    const error = workerError(errors[0].code, errors[0].message, errors[0].operation_index);
    error.errors = errors;
    return error;
  }

  function structuredPatchCode(operation) {
    const message = String(operation?.message ?? "");
    if (/not found/i.test(message)) return operation?.op === "replace_range" || operation?.op === "delete_range" ? "EXPECTED_CONTENT_NOT_FOUND" : "ANCHOR_NOT_FOUND";
    if (/exactly one|multiple|ambiguous/i.test(message)) return "AMBIGUOUS_ANCHOR";
    return operation?.code ?? "STRUCTURED_PATCH_INVALID";
  }

  function fileError(error, operationIndex = 0) {
    return {
      operation_index: Number.isInteger(error?.operationIndex) ? error.operationIndex : operationIndex,
      status: "invalid",
      code: error?.code ?? "MATERIALIZATION_INVALID",
      message: error?.message ?? "Material verification failed.",
      ...(error?.detail && typeof error.detail === "object" ? { detail: error.detail } : {})
    };
  }

  function workerError(code, message, operationIndex = 0) {
    const error = new Error(message);
    error.code = code;
    error.operationIndex = operationIndex;
    return error;
  }
}
