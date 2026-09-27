// agent lifecycle tools - provides agent lifecycle tools functionality for NodeForge.
import { createHash } from "node:crypto";
import { isProtectedPath } from "../infrastructure/filesystem/protected-path-policy.js";
import { assertCoderWorkflowReadOnly } from "../infrastructure/filesystem/file-service-role-policy.js";
import { ConfigurationError } from "../shared/errors.js";
import { loadAgentContextConventions } from "../modules/supervisor/agent-context-conventions.js";
import { resolveSymbolWindow, scopedGraph } from "./agent-file-index-view.js";
import { extractorRegistry } from "../modules/index/parser/index.js";
import { hasFileHeaderComment, extractFunctionSignatures, hasPrecedingComment } from "./agent-code-conventions.js";
import { discoveryNotice, recordRead, resetExploration } from "./exploration-state.js";
const MAX_CONTENT = 200000;
const WRITE_DIFF_MAX_LINES = 250;
const READ_WINDOW_LINE_LIMIT = 80;
// safePath - handles safePath operation.
const safePath = (value, operation = "read") => {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..") || isProtectedPath(value, { operation })) throw error("PATH_FORBIDDEN", "Path is outside the permitted project scope.");
  return value;
};
// checksum - handles checksum operation.
const checksum = (content) => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const checksumPattern = /^sha256:[a-fA-F0-9]{64}$/;
// error - handles error operation.
const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });
// textResult - handles textResult operation.
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

// checksumDiagnostics - handles checksumDiagnostics operation.
const checksumDiagnostics = (beforeChecksum, targetExists) => ({
  target_exists: targetExists,
  before_checksum_present: beforeChecksum !== null,
  before_checksum_format_valid: typeof beforeChecksum === "string" && checksumPattern.test(beforeChecksum)
});

// createReadFileTool - handles createReadFileTool operation.
export function createReadFileTool({ fileService, codeCache, maxChars = MAX_CONTENT } = {}) {
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("read_file requires File Service.");
  return Object.freeze({ name: "read_file", async execute(input = {}, context = {}) {
    const path = safePath(input.path); assertAllowed(path, context); const file = codeCache ? await codeCache.read({ path }) : await fileService.readForIndex({ path });
    if (!file || typeof file.content !== "string") throw error("READ_FAILED", `File could not be read: ${path}`);
    const sha256 = file.sha256 ?? checksum(file.content);
    const sizeBytes = file.size_bytes ?? Buffer.byteLength(file.content);
    const hasWindow = input.offset !== undefined || input.limit !== undefined;
    const lines = file.content.split("\n");
    const symbols = codeCache ? file.code_index?.symbols ?? [] : extractorRegistry.extract(path, file.content).symbols;
    const metadata = { path, sha256, size_bytes: sizeBytes, total_lines: lines.length,
      cache: file.cache ?? { status: "bypass", cached_at: null, expires_at: null }, content_sha256: file.content_sha256 ?? sha256,
      indexed_sha256: file.indexed_sha256 ?? null, index_version: file.index_version ?? null,
      index_status: file.index_status ?? "unavailable", code_index: file.code_index ?? { path, symbols },
      code_graph: scopedGraph(file.code_graph, context), symbol_map: symbols, discovery_budget: discoveryNotice(context) };
    if (!hasWindow && input.symbol === undefined) {
      recordRead(context, { path, window: "metadata" });
      return { ...metadata, notice: "Metadata only. To read source, call read_file with symbol or offset/limit (at most 80 lines)." };
    }
    let offset = input.offset ?? 1;
    let limit = input.limit ?? READ_WINDOW_LINE_LIMIT;
    if (input.symbol !== undefined) {
      if (hasWindow || typeof input.symbol !== "string" || !input.symbol) throw error("INPUT_INVALID", "symbol cannot be combined with offset/limit and must be a name.");
      const current = resolveSymbolWindow(file, path, input.symbol);
      if (!current) throw error("SYMBOL_STALE", `Symbol ${input.symbol} is absent from current source; search again or read an explicit window.`);
      offset = current.start_line;
      limit = current.end_line - current.start_line + 1;
      if (limit > READ_WINDOW_LINE_LIMIT) throw error("SYMBOL_TOO_LARGE", `Symbol ${input.symbol} spans ${limit} lines; read explicit windows of at most ${READ_WINDOW_LINE_LIMIT} lines.`);
    }
    if (!Number.isInteger(offset) || offset < 1) throw error("INPUT_INVALID", "offset must be a positive integer (1-based line).");
    if (offset > lines.length) throw error("OFFSET_OUT_OF_RANGE", `offset ${offset} is beyond the last line (${lines.length}) of ${path}.`);
    if (!Number.isInteger(limit) || limit < 1 || limit > READ_WINDOW_LINE_LIMIT) throw error("INPUT_INVALID", `limit must be an integer between 1 and ${READ_WINDOW_LINE_LIMIT}.`);
    const content = lines.slice(offset - 1, offset - 1 + limit).join("\n").slice(0, maxChars);
    recordRead(context, { path, window: input.symbol ?? `${offset}-${offset + limit - 1}` });
    return { ...metadata, content, offset, limit, truncated: offset + limit - 1 < lines.length || content.length === maxChars, ...(input.symbol ? { symbol: input.symbol } : {}) };
  }});
}


// createWriteDiffTool - handles createWriteDiffTool operation.
export function createWriteDiffTool({ fileService, codeCache, maxLines = WRITE_DIFF_MAX_LINES } = {}) {
  if (typeof fileService?.atomicWrite !== "function" || typeof fileService?.readFile !== "function") throw new ConfigurationError("write_diff requires File Service readFile and atomicWrite.");
  return Object.freeze({ name: "write_diff", async execute(input = {}, context = {}) {
    const path = safePath(input.path, "write"); assertAllowed(path, context); assertCoderWorkflowReadOnly(context.agent_identity?.role, "write", path); if (typeof input.content !== "string") throw error("CONTENT_INVALID", "content must be a string.");
    const lineCount = input.content ? input.content.split("\n").length - Number(input.content.endsWith("\n")) : 0;
    if (lineCount > maxLines) throw error("CONTENT_TOO_LARGE", `write_diff content has ${lineCount} lines, limit is ${maxLines}. For localized changes use edit_diff.`, { line_count: lineCount, limit: maxLines });
    let current;
    try {
      current = await fileService.readFile({ path });
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        throw error("READ_FAILED", `File could not be read: ${path}`, checksumDiagnostics(input.before_checksum, true));
      }
      if (input.before_checksum !== null) {
        throw error("CHECKSUM_MISMATCH", `File does not exist, but before_checksum was supplied for ${path}.`, checksumDiagnostics(input.before_checksum, false));
      }
      current = null;
    }
    if (current !== null) {
      const actual = checksum(current);
      if (typeof input.before_checksum !== "string" || input.before_checksum !== actual) throw error("CHECKSUM_MISMATCH", `Checksum mismatch for ${path}.`, checksumDiagnostics(input.before_checksum, true));
      const currentLines = current ? current.split("\n").length - Number(current.endsWith("\n")) : 0;
      if (currentLines > maxLines) throw error("DESTRUCTIVE_OVERWRITE", `${path} has ${currentLines} lines, over the ${maxLines}-line write_diff limit. Use edit_diff with an exact anchor for localized changes.`, { path, current_lines: currentLines, limit: maxLines });
    }
    assertSummaryEnforced(input.content, current, path);
    await fileService.atomicWrite({ path, content: input.content, replace: true });
    codeCache?.invalidate({ path });
    recordChangedPath(context, path);
    resetExploration(context);
    const reminder = current === null ? await buildConventionReminder(context, { newFile: true }) : "";
    return textResult(`Written '${path}' (${checksum(input.content)}).${reminder ? `\n\n${reminder}` : ""}`);
  }});
}

// createEditDiffTool - handles createEditDiffTool operation.
export function createEditDiffTool({ fileService, codeCache, maxChars = MAX_CONTENT } = {}) {
  if (typeof fileService?.atomicWrite !== "function" || typeof fileService?.readFile !== "function") throw new ConfigurationError("edit_diff requires File Service readFile and atomicWrite.");
  return Object.freeze({ name: "edit_diff", async execute(input = {}, context = {}) {
    const path = safePath(input.path, "write"); assertAllowed(path, context); assertCoderWorkflowReadOnly(context.agent_identity?.role, "write", path);
    if (typeof input.anchor !== "string" || !input.anchor.length) throw error("INPUT_INVALID", "anchor must be a non-empty string.");
    if (typeof input.replacement !== "string") throw error("INPUT_INVALID", "replacement must be a string.");
    if (input.anchor.length + input.replacement.length > maxChars) throw error("CONTENT_TOO_LARGE", `anchor + replacement exceeds ${maxChars} chars.`, { limit: maxChars });
    let current;
    try {
      current = await fileService.readFile({ path });
    } catch (cause) {
      if (cause?.code === "ENOENT") throw error("CHECKSUM_MISMATCH", `File does not exist: ${path}. Create it with write_diff first.`, checksumDiagnostics(input.before_checksum, false));
      throw error("READ_FAILED", `File could not be read: ${path}`, checksumDiagnostics(input.before_checksum, true));
    }
    const actual = checksum(current);
    if (typeof input.before_checksum !== "string" || input.before_checksum !== actual) throw error("CHECKSUM_MISMATCH", `Checksum mismatch for ${path}.`, checksumDiagnostics(input.before_checksum, true));
    const occurrence = input.occurrence === "all" ? "all" : "first";
    const parts = current.split(input.anchor);
    if (parts.length === 1) throw error("ANCHOR_NOT_FOUND", `Anchor was not found in ${path}. Read the file again and copy the exact text.`, { path });
    if (occurrence === "first" && parts.length > 2) throw error("ANCHOR_NOT_UNIQUE", `Anchor occurs ${parts.length - 1} times in ${path}; include more surrounding lines to make it unique.`, { path, occurrences: parts.length - 1 });
    const replaced = parts.join(input.replacement);
    const newFunctions = assertEditSummaryEnforced(current, replaced);
    await fileService.atomicWrite({ path, content: replaced, replace: true });
    codeCache?.invalidate({ path });
    recordChangedPath(context, path);
    resetExploration(context);
    const reminder = newFunctions.length ? await buildConventionReminder(context, { newFunctions }) : "";
    return { path, sha256: checksum(replaced), replaced_count: occurrence === "all" ? parts.length - 1 : 1, ...(reminder ? { reminder } : {}) };
  }});
}

export { createRunTestTool, createCheckTestTool, createCommitChangesTool } from "./agent-verification-tools.js";
export { createReportDoneTool } from "./agent-report-tool.js";

// withinPrefix - handles withinPrefix operation.
function withinPrefix(path, prefix) { return path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`); }
// assertAllowed - handles assertAllowed operation.
function assertAllowed(path, context) {
  const paths = context.allowed_file_paths ?? context.allowedFilePaths;
  const prefixes = context.allowed_prefixes ?? context.allowedPrefixes;
  const exactOk = !Array.isArray(paths) || paths.includes(path);
  const prefixOk = Array.isArray(prefixes) && prefixes.some((prefix) => withinPrefix(path, prefix));
  // A path is approved if it matches the exact allowlist OR falls inside an
  // approved prefix; otherwise reject with PATH_FORBIDDEN.
  if (exactOk || prefixOk) return;
  throw error("PATH_FORBIDDEN", `Path is not approved: ${path}`);
}

// write_diff/edit_diff record each successfully written path on the shared
// execution context so commit_changes commits exactly the files the agent
// changed, instead of a hard-coded target. The context object travels by
// reference through the Forge MCP session, so mutations here are visible to
// later tool calls in the same execution.
function assertSummaryEnforced(content, existing, path) {
  if (!content || typeof content !== "string") return;
  if (existing !== null && existing !== undefined) return;
  if (path.endsWith(".json")) {
    try { JSON.parse(content); return; }
    catch (cause) { throw error("CONTENT_INVALID", `New JSON file is invalid: ${cause.message}`); }
  }
  // Enforcement applies only to newly created files. Existing overwrites are
  // reviewed via comment-quality lint, not tool rejection.
  if (hasFileHeaderComment(content)) return;
  throw error("SUMMARY_REQUIRED", "New file must start with a concise summary comment describing its purpose. Add the comment at the very top of write_diff content.", { path: "write_diff.content" });
}

// assertEditSummaryEnforced - handles assertEditSummaryEnforced operation.
function assertEditSummaryEnforced(before, after) {
  const beforeFuncs = extractFunctionSignatures(before);
  const afterFuncs = extractFunctionSignatures(after);
  const newFunctions = [];
  for (const sig of afterFuncs) {
    if (beforeFuncs.has(sig)) continue;
    newFunctions.push(sig);
    if (hasPrecedingComment(after, sig)) continue;
    throw error("SUMMARY_REQUIRED", `New function "${sig}" must have a concise summary comment immediately before its definition. Add the comment on the line(s) right above the function declaration in the replacement.`, { function: sig });
  }
  return newFunctions;
}

// Builds a short just-in-time reminder for code that introduces new structure.
async function buildConventionReminder(context, { newFile = false, newFunctions = [] } = {}) {
  const ticket = context?.ticket ?? context?.task ?? context?.task_context;
  const projectRoot = context?.project_root ?? context?.projectRoot ?? process.cwd();
  const conventions = await loadAgentContextConventions({ projectRoot, ticket });
  const lines = ["Convention reminder: add a short summary comment describing the business purpose before new code."];
  if (newFile) lines.push("This is a new file; put the summary comment at the top of the file.");
  if (newFunctions.length) lines.push(`New function(s): ${newFunctions.join(", ")}. Put the summary comment immediately before each definition.`);
  if (conventions.mappings.length) lines.push(`Relevant vocabulary mapping(s): ${conventions.mappings.map(formatConventionMapping).join("; ")}`);
  return lines.join(" ");
}

// Formats the shared glossary row as the compact mapping reminder shown at edit time.
function formatConventionMapping(raw) {
  const cells = String(raw).split("|").map((cell) => cell.trim()).filter(Boolean);
  const business = (cells[0] ?? "").replace(/\s*\([^)]*\)\s*$/, "");
  const code = (cells[1] ?? "").replace(/`/g, "").replace(/\s*,\s*/g, "/");
  return `${business} -> ${code}`;
}

// recordChangedPath - handles recordChangedPath operation.
function recordChangedPath(context, path) {
  if (!context || typeof context !== "object") return;
  const paths = Array.isArray(context.changed_paths) ? context.changed_paths : [];
  if (!paths.includes(path)) paths.push(path);
  context.changed_paths = paths;
}
