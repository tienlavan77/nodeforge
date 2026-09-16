// Summary: Reads exactly one Node-approved file or symbol through Forge File Service.

import { isAbsolute } from "node:path";
import { ConfigurationError } from "../shared/errors.js";
import { isProtectedPath } from "../infrastructure/filesystem/protected-path-policy.js";
import { assertExecutionScope, checkRetrievalBudget, recordRetrieval } from "./retrieval-governance.js";
import { discoveryNotice } from "./exploration-state.js";

const DEFAULT_MAX_CHARS = 50000;
const HARD_MAX_CHARS = 100000;
const IGNORED_PREFIXES = [".git/", ".forge/", ".next/", ".next.stale-", "agent-tool/"];

export function createReadCodeTool({ fileService, maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("Read Code tool requires Forge File Service readForIndex.");
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > HARD_MAX_CHARS) throw new ConfigurationError("Read Code service maxChars is invalid.");
  return Object.freeze({ name: "read_code", execute });

  async function execute(input = {}, context = {}) {
    const taskId = context.task_id ?? context.taskId;
    if (!new Set(context.capabilities ?? []).has("read_code")) throw scopedError("TOOL_FORBIDDEN", "Agent is not authorized to use read_code.");
    if (typeof taskId !== "string" || !taskId) throw scopedError("TOOL_SCOPE_INVALID", "Read Code requires the current task_id.");
    assertExecutionScope(context, taskId);
    const kind = input.kind;
    if (kind !== "file" && kind !== "symbol") throw scopedError("READ_KIND_INVALID", "Read kind must be file or symbol.");
    const path = validatePath(input.path);
    const allowedFiles = validateAllowedFiles(context.allowed_file_paths ?? context.allowedFilePaths);
    if (!allowedFiles.has(path)) throw scopedError("READ_PATH_FORBIDDEN", "Read path is outside the exact Node-approved file allowlist.");
    const requestedMax = input.max_chars;
    if (!Number.isInteger(requestedMax) || requestedMax < 1000 || requestedMax > maxChars) throw scopedError("READ_LIMIT_INVALID", `max_chars must be an integer between 1000 and ${maxChars}.`);
    const symbol = kind === "symbol" ? validateSymbol(input, context.allowed_symbols ?? context.allowedSymbols, path) : null;
    checkRetrievalBudget(context, requestedMax, "read_code");
    let file;
    try { file = await fileService.readForIndex({ path }); }
    catch (error) {
      if (error?.code === "ENOENT") throw scopedError("READ_FILE_NOT_FOUND", `Approved file was not found: ${path}.`, error);
      throw scopedError("READ_BACKEND_ERROR", "Forge File Service failed to read the approved file.", error);
    }
    if (!file || typeof file.content !== "string") throw scopedError("READ_BACKEND_ERROR", "Forge File Service returned invalid file content.");
    const content = symbol ? sliceSymbol(file.content, symbol) : file.content;
    const returnedContent = content.slice(0, requestedMax);
    const result = {
      task_id: taskId, kind, path, content: returnedContent, language: file.language ?? null,
      sha256: file.sha256 ?? null, size_bytes: Number.isInteger(file.size_bytes) ? file.size_bytes : Buffer.byteLength(file.content, "utf8"),
      truncated: content.length > requestedMax,
      ...(symbol ? { symbol: symbol.name, symbol_kind: symbol.symbol_kind ?? "unknown", start_line: symbol.start_line, end_line: symbol.end_line } : {})
    };
    recordRetrieval(context, { bytes: Buffer.byteLength(returnedContent, "utf8"), tool: "read_code", kind, taskId, resource: path });
    result.discovery_budget = discoveryNotice(context);
    return result;
  }
}

function validatePath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\0") || isProtectedPath(path, { operation: "read" }) || isIgnoredPath(path)) throw scopedError("READ_PATH_FORBIDDEN", "Read path must be a safe, relative, non-ignored project path.");
  return path;
}

function validateAllowedFiles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((path) => typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || isProtectedPath(path, { operation: "read" }) || isIgnoredPath(path)) || new Set(value).size !== value.length) throw scopedError("TOOL_SCOPE_INVALID", "Node must provide a valid exact allowed_file_paths list.");
  return new Set(value);
}

function validateSymbol(input, value, path) {
  if (!Array.isArray(value) || value.length < 1) throw scopedError("TOOL_SCOPE_INVALID", "Node must provide approved symbols for symbol reads.");
  const start = input.start_line;
  const end = input.end_line;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw scopedError("READ_SYMBOL_FORBIDDEN", "Symbol line range is invalid.");
  const match = value.find((candidate) => candidate?.path === path && candidate?.name === input.symbol && candidate?.start_line === start && candidate?.end_line === end);
  if (!match) throw scopedError("READ_SYMBOL_FORBIDDEN", "Symbol and line range are outside the Node-approved symbol allowlist.");
  return match;
}

function sliceSymbol(content, symbol) {
  const lines = content.split(/\r?\n/);
  if (symbol.start_line > lines.length || symbol.end_line > lines.length) throw scopedError("READ_SYMBOL_FORBIDDEN", "Approved symbol range exceeds the file.");
  return lines.slice(symbol.start_line - 1, symbol.end_line).join("\n");
}
function isIgnoredPath(path) { return IGNORED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix)); }
function scopedError(code, message, cause) { const error = new ConfigurationError(message, cause ? { cause } : {}); error.code = code; return error; }
