import { createHash } from "node:crypto";
import { isProtectedPath } from "../infrastructure/filesystem/protected-path-policy.js";
import { ConfigurationError } from "../shared/errors.js";
import { discoveryCount, discoveryNotice, recordRead, resetExploration } from "./exploration-state.js";
const MAX_CONTENT = 200000;
const WRITE_DIFF_MAX_BYTES = 8192;
const READ_PREVIEW_LINES = 40;
const FULL_READ_LINE_LIMIT = 500;
const safePath = (value, operation = "read") => {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..") || isProtectedPath(value, { operation })) throw error("PATH_FORBIDDEN", "Path is outside the permitted project scope.");
  return value;
};
const checksum = (content) => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const checksumPattern = /^sha256:[a-fA-F0-9]{64}$/;
const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

const checksumDiagnostics = (beforeChecksum, targetExists) => ({
  target_exists: targetExists,
  before_checksum_present: beforeChecksum !== null,
  before_checksum_format_valid: typeof beforeChecksum === "string" && checksumPattern.test(beforeChecksum)
});

export function createReadFileTool({ fileService, symbolLookup, maxChars = MAX_CONTENT } = {}) {
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("read_file requires File Service.");
  return Object.freeze({ name: "read_file", async execute(input = {}, context = {}) {
    const path = safePath(input.path); assertAllowed(path, context); const file = await fileService.readForIndex({ path });
    if (!file || typeof file.content !== "string") throw error("READ_FAILED", `File could not be read: ${path}`);
    const sha256 = file.sha256 ?? checksum(file.content);
    const sizeBytes = file.size_bytes ?? Buffer.byteLength(file.content);
    const hasWindow = input.offset !== undefined || input.limit !== undefined;
    const lines = file.content.split("\n");
    if (!hasWindow && lines.length > FULL_READ_LINE_LIMIT) {
      // Refusing full reads of large files forces windowed navigation; the
      // sha256 stays whole-file so edit_diff before_checksum still works. The
      // symbol map lets the agent aim its first window instead of blind probing.
      recordRead(context, { path, window: "preview" });
      const symbols = typeof symbolLookup === "function" ? symbolLookup(path) : [];
      const result = { path, content: lines.slice(0, READ_PREVIEW_LINES).join("\n"), sha256, size_bytes: sizeBytes, offset: 1, limit: READ_PREVIEW_LINES, total_lines: lines.length, truncated: true, symbol_map: symbols, notice: `File has ${lines.length} lines. Re-call read_file with offset/limit windows (max 500 lines) targeting the symbol you need; symbol_map gives each symbol's line range.`, discovery_budget: discoveryNotice(context) };
      const discovery = discoveryCount(context);
      if (!discovery.edit_started && discovery.remaining <= 2) result.deadline_warning = `${discovery.used} discovery calls used. Discovery is refused after ${discovery.limit}; your next calls must be edit_diff or write_diff.`;
      return result;
    }
    if (!hasWindow) {
      const content = file.content.slice(0, maxChars);
      recordRead(context, { path, window: "full" });
      return { path, content, sha256, size_bytes: sizeBytes, truncated: content.length < file.content.length, discovery_budget: discoveryNotice(context) };
    }
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) throw error("INPUT_INVALID", "offset must be a positive integer (1-based line).");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) throw error("INPUT_INVALID", "limit must be an integer between 1 and 500.");
    const offset = input.offset ?? 1;
    if (offset > lines.length) throw error("OFFSET_OUT_OF_RANGE", `offset ${offset} is beyond the last line (${lines.length}) of ${path}.`);
    const limit = input.limit ?? 500;
    const content = lines.slice(offset - 1, offset - 1 + limit).join("\n").slice(0, maxChars);
    recordRead(context, { path, window: `${offset}-${offset - 1 + Math.min(limit, lines.length - offset + 1)}` });
    return { path, content, sha256, size_bytes: sizeBytes, offset, limit, total_lines: lines.length, truncated: content.length === maxChars && maxChars < file.content.length, discovery_budget: discoveryNotice(context) };
  }});
}

export function createWriteDiffTool({ fileService, maxChars = MAX_CONTENT, maxBytes = WRITE_DIFF_MAX_BYTES } = {}) {
  if (typeof fileService?.atomicWrite !== "function" || typeof fileService?.readFile !== "function") throw new ConfigurationError("write_diff requires File Service readFile and atomicWrite.");
  return Object.freeze({ name: "write_diff", async execute(input = {}, context = {}) {
    const path = safePath(input.path, "write"); assertAllowed(path, context); if (typeof input.content !== "string" || input.content.length > maxChars) throw error("CONTENT_INVALID", "content must be a bounded string.");
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > maxBytes) throw error("CONTENT_TOO_LARGE", `write_diff content is ${byteLength} bytes, limit is ${maxBytes}. For existing files use edit_diff with an anchor; for new files split into smaller writes.`, { byte_length: byteLength, limit: maxBytes });
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
      // A file too large to be a legitimate write_diff payload must be edited in
      // place; write_diff only creates or fully rewrites a small (< maxBytes) file.
      const currentBytes = Buffer.byteLength(current, "utf8");
      if (currentBytes > maxBytes) throw error("DESTRUCTIVE_OVERWRITE", `${path} is ${currentBytes} bytes, over the ${maxBytes}-byte write_diff limit. Replace it with write_diff would drop content; use edit_diff with an exact anchor for localized changes.`, { path, current_bytes: currentBytes, limit: maxBytes });
    }
    await fileService.atomicWrite({ path, content: input.content, replace: true });
    recordChangedPath(context, path);
    resetExploration(context);
    return textResult(`Written '${path}' (${checksum(input.content)}).`);
  }});
}

export function createEditDiffTool({ fileService, maxChars = MAX_CONTENT } = {}) {
  if (typeof fileService?.atomicWrite !== "function" || typeof fileService?.readFile !== "function") throw new ConfigurationError("edit_diff requires File Service readFile and atomicWrite.");
  return Object.freeze({ name: "edit_diff", async execute(input = {}, context = {}) {
    const path = safePath(input.path, "write"); assertAllowed(path, context);
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
    await fileService.atomicWrite({ path, content: replaced, replace: true });
    recordChangedPath(context, path);
    resetExploration(context);
    return { path, sha256: checksum(replaced), replaced_count: occurrence === "all" ? parts.length - 1 : 1 };
  }});
}

export function createRunTestTool({ testService } = {}) {
  if (typeof testService?.startTests !== "function") throw new ConfigurationError("run_test requires Test Service startTests.");
  return Object.freeze({ name: "run_test", async execute(input = {}, context = {}) {
    if (Object.keys(input).length) throw error("INPUT_INVALID", "run_test accepts no arguments.");
    const started = testService.startTests({ commitId: context.commit_id ?? `WORKTREE-${context.task_id ?? Date.now()}`, taskId: context.task_id, sessionId: context.session_id, command: "node --test backend/tests/tools/*.test.js" });
    return { ...started, message: "Test job started. Poll check_test with this job_id until status is passed or failed." };
  }});
}

export function createCheckTestTool({ testService } = {}) {
  if (typeof testService?.getTestResult !== "function") throw new ConfigurationError("check_test requires Test Service getTestResult.");
  return Object.freeze({ name: "check_test", async execute(input = {}, context = {}) {
    if (typeof input?.job_id !== "string" || !input.job_id.trim()) throw error("INPUT_INVALID", "check_test requires a job_id string returned by run_test.");
    const result = await testService.getTestResult({ jobId: input.job_id.trim(), taskId: context.task_id });
    if (result && typeof result === "object") context.verify_result = result;
    return result;
  }});
}

export function createCommitChangesTool({ gitService } = {}) {
  if (typeof gitService?.commit !== "function") throw new ConfigurationError("commit_changes requires Git Service.");
  return Object.freeze({ name: "commit_changes", async execute(input = {}, context = {}) {
    if (typeof input.message !== "string" || !input.message.trim()) throw error("INPUT_INVALID", "Commit message is required.");
    const paths = resolveCommitPaths(context);
    if (!paths.length) throw error("SCOPE_INVALID", "No changed files to commit; write_diff/edit_diff must run first.");
    return gitService.commit(input.message, { paths });
  }});
}

export function createReportDoneTool({ reportService } = {}) {
  if (!reportService?.buildFinalReport || !reportService?.saveReport || !reportService?.writeReportFile) throw new ConfigurationError("report_done requires Stage1 Report Service.");
  return Object.freeze({ name: "report_done", async execute(input = {}, context = {}) {
    if (typeof input.summary !== "string" || !input.summary.trim()) throw error("INPUT_INVALID", "Report summary is required.");
    const ticket = context.ticket ?? context.task;
    if (!ticket?.id) throw error("SCOPE_INVALID", "Node must provide the current ticket for report_done.");
    assertReportScope(ticket, context);
    const report = await reportService.buildFinalReport({ ticket, status: context.status ?? "completed", verifyResult: context.verify_result ?? null, filesChanged: context.changed_paths ?? [], reason: "agent_report_done" });
    assertReportVerified(report);
    report.agent_report = { ...(report.agent_report ?? {}), summary: input.summary.trim() };
    await reportService.saveReport(ticket.id, report); await reportService.writeReportFile(ticket.id, report);
    return textResult("Completion report recorded.");
  }});
}

function assertReportScope(ticket, context) {
  if (context.lab_mode || context.labMode) return;
  const changed = Array.isArray(context.changed_paths) ? context.changed_paths.filter((path) => typeof path === "string" && path) : [];
  if (changed.length === 1 && changed[0] === "backend/tool-lab-target.txt") throw error("REPORT_SCOPE_INVALID", "Tool-lab marker cannot complete a real ticket.");
  // When the ticket names an explicit target file, completion requires that the
  // target itself was changed. Without this, an agent could edit any other file
  // inside an allowed prefix (observed: Codex touching an unrelated UI file to
  // satisfy a loose "some UI file" check) and still report done off-target.
  const target = typeof context.target_path === "string" && context.target_path ? context.target_path : null;
  if (target && !changed.includes(target)) {
    throw error("REPORT_SCOPE_INVALID", `Ticket target is ${target} but it was not changed; completion must touch the target file, not an unrelated file in the same prefix.`);
  }
  // Only demand a UI file change when the ticket actually has UI acceptance
  // criteria. isUiTicket() is a loose keyword test (it fires on the word
  // "page" even when the ticket is purely backend and merely mentions where an
  // action is triggered from), so gating completion on it forced agents to
  // fabricate an orphan UI file just to satisfy report_done.
  if (hasUiCriteria(ticket) && !changed.some(isUiPath)) throw error("REPORT_SCOPE_INVALID", "UI ticket cannot be completed without changing a UI file.");
  // A full-stack ticket (explicit backend acceptance criteria AND UI scope) must
  // change real backend code too, not just the UI. Without this, an agent that
  // only edits the frontend panel silently passes while the backend endpoint,
  // DB persist, and error handling sit unimplemented.
  if (isUiTicket(ticket) && hasBackendCriteria(ticket) && !changed.some(isBackendPath)) {
    throw error("REPORT_SCOPE_INVALID", "Ticket has explicit backend acceptance criteria but no backend file was changed; UI-only work cannot complete it.");
  }
  if (hasBackendCriteria(ticket) && changed.some(isBackendPath) && !changed.some(isBackendImplementationPath)) {
    throw error("REPORT_SCOPE_INVALID", "Backend acceptance criteria require a backend implementation file, not only a backend test or metadata file.");
  }
}

function assertReportVerified(report) {
  if (report?.status !== "completed") return;
  const checks = Array.isArray(report.criteria_check) ? report.criteria_check : [];
  const verifiable = checks.filter((item) => /syntax|build|compile|test|lint/i.test(item?.criterion ?? ""));
  if (verifiable.length && verifiable.every((item) => item?.node_verified === null)) throw error("REPORT_UNVERIFIED", "Node did not verify any build/test acceptance criteria; completion report is blocked.");
}

function isUiTicket(ticket) {
  const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])]
    .filter((value) => typeof value === "string")
    .join(" ");
  return /\b(ui|frontend|front-end|react|next(?:\.js)?|component|page|button|layout|watcher|header|screen|responsive|status(?: area| line)?|dashboard|modal)\b/i.test(text);
}

function hasBackendCriteria(ticket) {
  return (ticket?.acceptance_criteria ?? []).some((criterion) => {
    if (typeof criterion !== "string") return false;
    if (/\b(backend|back-end|server|endpoint|api|database|db|sqlite|sprint leader|request payload)\b/i.test(criterion)) return true;
    // "persist to localStorage" is a frontend requirement, not backend work.
    // Only treat persistence as backend when the criterion names a server-side store.
    return /\b(persist|persistence)\b/i.test(criterion) && /\b(database|db|sqlite|server|backend|back-end)\b/i.test(criterion);
  });
}

function hasUiCriteria(ticket) {
  return (ticket?.acceptance_criteria ?? []).some((criterion) =>
    typeof criterion === "string" && /\b(ui|frontend|front-end|react|next(?:\.js)?|component|button|layout|watcher|header|screen|responsive|modal|dashboard)\b/i.test(criterion)
  );
}

function isUiPath(path) {
  return path.startsWith("ui/nextjs/") || path.startsWith("ui/src/") || path.startsWith("web/src/");
}

function isBackendPath(path) {
  return path.startsWith("backend/src/") || path.startsWith("backend/tests/");
}

function isBackendImplementationPath(path) {
  return path.startsWith("backend/src/");
}

function withinPrefix(path, prefix) { return path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`); }
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
function recordChangedPath(context, path) {
  if (!context || typeof context !== "object") return;
  const paths = Array.isArray(context.changed_paths) ? context.changed_paths : [];
  if (!paths.includes(path)) paths.push(path);
  context.changed_paths = paths;
}

function resolveCommitPaths(context) {
  const changed = Array.isArray(context.changed_paths) ? context.changed_paths.filter((path) => typeof path === "string" && path) : [];
  if (changed.length) return changed;
  const allowed = Array.isArray(context.allowed_file_paths) ? context.allowed_file_paths : [];
  return allowed.filter((path) => typeof path === "string" && path);
}
