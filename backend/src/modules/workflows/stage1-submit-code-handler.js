import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { applyUnifiedDiff } from "../../application/execution-handlers/unified-diff.js";
import { applyApplyPatch } from "../../application/execution-handlers/apply-patch.js";
import { resolveSubmissionFormat } from "./submission-format.js";
import { validateSyntax } from "./validate-syntax.js";
import { inspectStructuredPatch } from "./structured-patch.js";

/** Applies the first-round full-file submission through File Service and commits it. */
export function createStage1SubmitCodeHandler({ fileService, gitService, statusStore, protocolLogger, unwiredChecker } = {}) {
  if (typeof fileService?.atomicCreate !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Submit-code handler requires File Service atomicCreate and atomicWrite.");
  if (typeof gitService?.commit !== "function") throw new ConfigurationError("Submit-code handler requires Git Service commit.");
  if (statusStore !== undefined && (typeof statusStore.updateStatus !== "function" || typeof statusStore.get !== "function")) throw new ConfigurationError("Submit-code handler requires a valid status store.");
  if (protocolLogger !== undefined && typeof protocolLogger.failed !== "function") throw new ConfigurationError("Submit-code handler requires a valid Protocol Step Logger.");
  if (unwiredChecker !== undefined && typeof unwiredChecker.checkUnwiredFiles !== "function") throw new ConfigurationError("Submit-code handler requires a valid unwired-file checker.");
  return Object.freeze({ handleSubmitCode });

  async function handleSubmitCode(response, { taskId, projectId, ticketId = taskId, contextFiles = [] } = {}) {
    assertResponse(response);
    assertUniquePaths(response.payload.files);
    validateStructuredPatchPayload(response.payload.files);
    const exchangeResponse = await materializeChanges(response);
    if (typeof taskId !== "string" || !taskId) throw new ConfigurationError("Submit-code handler requires taskId.");
    const contextByPath = new Map((Array.isArray(contextFiles) ? contextFiles : []).map((file) => [file.path, file]));
    const files = exchangeResponse.payload.files.map((file) => {
      const context = contextByPath.get(file.path);
      if (file.exists === true && file.before_checksum === null && typeof context?.before_checksum === "string") {
        return { ...file, before_checksum: context.before_checksum };
      }
      return file;
    });
    // Validate every file before the first write so malformed submissions cannot partially apply.
    for (const file of files) {
      assertSubmission(file);
      if (file.format === "full_content" && file.exists && file.before_checksum !== null) {
        if (!Number.isInteger(file.content_size_bytes)) throw handlerError("INVALID_PAYLOAD", `Existing full_content file ${file.path} requires content_size_bytes.`);
        const actualAgentSize = Buffer.byteLength(file.content, "utf8");
        if (actualAgentSize < file.content_size_bytes) throw handlerError("SUBMISSION_TRUNCATED", `Full-content response for ${file.path} is shorter than its declared UTF-8 size.`);
      }
    }
    for (const file of files) {
      const syntax = validateSyntax(file.language, file.content);
      if (!syntax.valid) throw handlerError("SYNTAX_INVALID", `Invalid ${file.language ?? "source"} syntax in ${file.path}: ${syntax.error}`);
      if (!file.exists) {
        if (file.before_checksum !== null) throw handlerError("CHECKSUM_MISMATCH", `New file ${file.path} must use before_checksum=null.`);
        if (typeof file.summary !== "string" || !file.summary.trim() || /[\r\n]/.test(file.summary) || file.summary.length > 160) throw handlerError("INVALID_PAYLOAD", `New file ${file.path} requires a one-line summary (1-160 characters).`);
        continue;
      }
      if (typeof file.before_checksum !== "string") throw handlerError("CHECKSUM_MISMATCH", `Existing file ${file.path} requires before_checksum.`);
      if (typeof fileService.readFile !== "function") throw handlerError("IO_ERROR", `Cannot verify checksum for ${file.path}: File Service readFile is unavailable.`);
      let current;
      try { current = await fileService.readFile({ path: file.path }); }
      catch (error) { throw handlerError("IO_ERROR", `Cannot read ${file.path} to verify checksum: ${error.message}`); }
      const actual = `sha256:${createHash("sha256").update(current, "utf8").digest("hex")}`;
      if (actual !== file.before_checksum) throw handlerError("CHECKSUM_MISMATCH", `File changed after context was provided: ${file.path}.`);
    }
    const paths = files.map(({ path }) => path);
    try {
      for (const file of files) {
        const content = file.exists ? file.content : prependSummary(file.content, file.summary, file.language);
        if (file.exists) await fileService.atomicWrite({ path: file.path, content, replace: true });
        else await fileService.atomicCreate({ path: file.path, content });
      }
      const commit = await gitService.commit(`Implement ${ticketId}`, { paths });
      const updated = statusStore ? updateReviewing(ticketId, projectId, paths, commit) : undefined;
      const filesChanged = files.map((file) => ({ path: file.path, action: file.exists ? "modified" : "created" }));
      const unwiredFiles = unwiredChecker ? unwiredChecker.checkUnwiredFiles(filesChanged) : [];
      return Object.freeze({ status: updated, commit, files: paths, files_changed: filesChanged, unwired_files: unwiredFiles });
    } catch (error) {
      protocolLogger?.failed({ task_id: taskId, step_id: 2, type: response.type, role: response.role, request_id: response.request_id, parent_id: response.parent_id, status: "failed", error_code: error.code ?? "SUBMISSION_FAILED", error_message: error.message });
      throw error;
    }
  }

  async function materializeChanges(input) {
    const files = [];
    const validPatches = [];
    const invalidPatches = [];
    for (const [fileIndex, file] of input.payload.files.entries()) {
      try {
        const format = resolveSubmissionFormat(file.format);
        if (format === "full_content") {
          files.push({ ...file, format });
          validPatches.push({ index: fileIndex, path: file.path, format, status: "valid" });
          continue;
        }
        if (!file.exists) throw handlerError("SUBMISSION_FORMAT_UNSUPPORTED", `${format} cannot create a file; use full_content: ${file.path}.`);
        if (typeof file.before_checksum !== "string") throw handlerError("PATCH_CONTEXT_REQUIRED", `${format} requires before_checksum: ${file.path}.`);
        let content;
        if (format === "unified_diff") {
          const result = await applyUnifiedDiff(file.path, file.content, { dry_run: true, fileService });
          if (!result?.success || typeof result.detail?.content !== "string") throw handlerError(result?.error_code ?? "PATCH_NOT_APPLICABLE", result?.error_message ?? `Cannot apply ${format}: ${file.path}.`);
          content = result.detail.content;
        } else if (format === "apply_patch") {
          if (typeof file.content !== "string") throw handlerError("INVALID_PAYLOAD", `apply_patch content must be a string: ${file.path}.`);
          const result = await applyApplyPatch(file.path, file.content, { dry_run: true, fileService });
          if (!result?.success || typeof result.detail?.content !== "string") throw handlerError(result?.error_code ?? "PATCH_NOT_APPLICABLE", result?.error_message ?? `Cannot apply ${format}: ${file.path}.`);
          content = result.detail.content;
        } else if (format === "structured_patch") {
          const original = await fileService.readFile({ path: file.path });
          const inspected = inspectStructuredPatch(original, file.content);
          validPatches.push(...inspected.valid_operations.map((operation) => ({ index: fileIndex, path: file.path, format, ...operation })));
          invalidPatches.push(...inspected.invalid_operations.map((operation) => ({ index: fileIndex, path: file.path, format, ...operation })));
          if (!inspected.success) continue;
          content = inspected.content;
        } else {
          throw handlerError("SUBMISSION_FORMAT_UNSUPPORTED", `Unsupported code exchange format: ${file.format}.`);
        }
        files.push({ ...file, content, materialized: true });
        if (format !== "structured_patch") validPatches.push({ index: fileIndex, path: file.path, format, status: "valid" });
      } catch (error) {
        invalidPatches.push({ index: fileIndex, path: file.path, format: file.format, code: error.code ?? "PATCH_NOT_APPLICABLE", message: error.message });
      }
    }
    if (invalidPatches.length) {
      const summary = invalidPatches.map(({ path, operation_index, message }) => `${path}${operation_index === undefined ? "" : `[${operation_index}]`}: ${message}`).join("; ");
      const failure = handlerError("PATCH_BATCH_INVALID", `Patch verification completed: ${invalidPatches.length} invalid, ${validPatches.length} valid. Invalid patches: ${summary}`);
      failure.details = { valid_patches: validPatches, invalid_patches: invalidPatches };
      failure.valid_patches = validPatches;
      failure.invalid_patches = invalidPatches;
      throw failure;
    }
    return { ...input, payload: { ...input.payload, files } };
  }

  function updateReviewing(ticketId, projectId, paths, commit) {
    const current = statusStore.get(ticketId);
    if (!current) throw handlerError("STATUS_NOT_FOUND", `Ticket status not found: ${ticketId}.`);
    if (current.status !== "running") throw handlerError("STATUS_TRANSITION_INVALID", `Ticket must be running before reviewing: ${current.status}.`);
    return statusStore.updateStatus(ticketId, "reviewing", { reason: "code_submitted", project_id: projectId, paths, commit }, { expectedCurrentStatus: "running" });
  }
}

function assertResponse(response) {
  if (!response || response.type !== "submit_code_response" || response.role !== "agent" || !response.payload || !Array.isArray(response.payload.files) || response.payload.files.length === 0) throw new ConfigurationError("Submit-code handler requires an Agent submit_code_response with files.");
}
function assertUniquePaths(files) {
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) throw handlerError("DUPLICATE_FILE_PATH", "Only one submission entry is allowed per path: " + file.path + ". Combine all operations for that file.");
    seen.add(file.path);
  }
}

function validateStructuredPatchPayload(files) {
  const allowed = {
    replace_range: new Set(["op", "expected_content", "new_content"]),
    delete_range: new Set(["op", "expected_content"]),
    insert_after: new Set(["op", "anchor_text", "new_content"]),
    insert_at_end: new Set(["op", "new_content"])
  };
  for (const file of files) {
    if (file.format !== "structured_patch") continue;
    if (!file.content || typeof file.content !== "object" || !Array.isArray(file.content.operations)) throw handlerError("INVALID_STRUCTURED_PATCH", "structured_patch content must contain operations: " + file.path + ".");
    for (const [index, operation] of file.content.operations.entries()) {
      const fields = allowed[operation?.op];
      if (!fields) throw handlerError("INVALID_STRUCTURED_PATCH", "Unsupported structured_patch operation at " + file.path + "[" + index + "].");
      const extra = Object.keys(operation).filter((key) => !fields.has(key));
      if (extra.length) throw handlerError("INVALID_STRUCTURED_PATCH", "Operation " + index + " at " + file.path + " contains unused fields.");
      for (const field of fields) {
        if (field === "op") continue;
        if (!(field in operation) || typeof operation[field] !== "string") throw handlerError("INVALID_STRUCTURED_PATCH", "Operation " + index + " at " + file.path + " requires string " + field + ".");
      }
      if ((operation.op === "replace_range" || operation.op === "delete_range") && operation.expected_content.length === 0) throw handlerError("INVALID_STRUCTURED_PATCH", "Operation " + index + " at " + file.path + " requires non-empty expected_content.");
      if (operation.op === "insert_after" && operation.anchor_text.length === 0) throw handlerError("INVALID_STRUCTURED_PATCH", "Operation " + index + " at " + file.path + " requires non-empty anchor_text.");
    }
  }
}

function assertSubmission(file) {
  if (!file || typeof file !== "object" || typeof file.path !== "string" || !file.path || !["full_content", "structured_patch", "apply_patch", "unified_diff"].includes(file.format) || typeof file.content !== "string" || typeof file.exists !== "boolean" || !(typeof file.before_checksum === "string" || file.before_checksum === null)) throw handlerError("SUBMISSION_FORMAT_UNSUPPORTED", "Stage-1 accepts a canonical code response with path, content, format, exists, and before_checksum.");
}
function handlerError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }
function prependSummary(content, summary, language) {
  const line = summary.trim().replace(/[\r\n]+/g, " ");
  const normalized = String(language).toLowerCase();
  const comment = ["javascript", "typescript", "jsx", "tsx", "java", "c", "cpp", "csharp", "go", "rust", "php", "swift", "kotlin"].includes(normalized) ? `// NodeForge summary: ${line}` : ["css", "scss", "less"].includes(normalized) ? `/* NodeForge summary: ${line} */` : ["python", "ruby", "shell", "bash", "yaml", "toml", "ini", "dockerfile", "text"].includes(normalized) ? `# NodeForge summary: ${line}` : null;
  if (!comment) throw handlerError("INVALID_PAYLOAD", `Cannot add summary comment for unsupported language: ${language}.`);
  const shebang = content.startsWith("#!") ? content.match(/^#![^\r\n]*(?:\r?\n|$)/)?.[0] ?? "" : "";
  return shebang + comment + "\n" + content.slice(shebang.length);
}
