import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { applyUnifiedDiff } from "../../application/execution-handlers/unified-diff.js";
import { applyApplyPatch } from "../../application/execution-handlers/apply-patch.js";

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
      assertFullFile(file);
      const context = contextByPath.get(file.path);
      const contextBytes = context?.content ? Buffer.byteLength(context.content, "utf8") : 0;
      if (file.exists && contextBytes > 2048 && Buffer.byteLength(file.content, "utf8") < Math.floor(contextBytes * 0.5)) {
        throw handlerError("SUBMISSION_TRUNCATED", `Full-file submission for ${file.path} is substantially smaller than the provided context.`);
      }
    }
    for (const file of files) {
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
      protocolLogger?.failed({ task_id: taskId, step_id: 2, type: response.type, role: response.role, request_id: response.request_id, parent_id: response.parent_id, status: "failed" });
      throw error;
    }
  }

  async function materializeChanges(input) {
    const files = [];
    for (const file of input.payload.files) {
      const format = normalizeFormat(file.format);
      if (format === "full_content") { files.push({ ...file, format }); continue; }
      if (!file.exists) throw handlerError("SUBMISSION_FORMAT_UNSUPPORTED", `${format} cannot create a file; use full_content: ${file.path}.`);
      if (typeof file.before_checksum !== "string") throw handlerError("PATCH_CONTEXT_REQUIRED", `${format} requires before_checksum: ${file.path}.`);
      let result;
      if (format === "unified_diff") result = await applyUnifiedDiff(file.path, file.content, { dry_run: true, fileService });
      else if (format === "apply_patch") {
        if (typeof file.content !== "string") throw handlerError("INVALID_PAYLOAD", `apply_patch content must be a string: ${file.path}.`);
        result = await applyApplyPatch(file.path, file.content, { dry_run: true, fileService });
      } else throw handlerError("SUBMISSION_FORMAT_UNSUPPORTED", `Unsupported code exchange format: ${file.format}.`);
      if (!result?.success || typeof result.detail?.content !== "string") throw handlerError(result?.error_code ?? "PATCH_NOT_APPLICABLE", result?.error_message ?? `Cannot apply ${format}: ${file.path}.`);
      files.push({ ...file, format: "full_content", content: result.detail.content });
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
function normalizeFormat(format) { return format === "full" ? "full_content" : format === "patch" ? "apply_patch" : format === "apply_patch" ? "apply_patch" : format; }
function assertFullFile(file) {
  if (!file || typeof file !== "object" || typeof file.path !== "string" || !file.path || file.format !== "full_content" || typeof file.content !== "string" || typeof file.exists !== "boolean" || !(typeof file.before_checksum === "string" || file.before_checksum === null)) throw handlerError("SUBMISSION_FORMAT_UNSUPPORTED", "Stage-1 accepts full files with path, content, exists, before_checksum, and format=full_content.");
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
