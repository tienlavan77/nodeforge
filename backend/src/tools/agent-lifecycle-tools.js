import { createHash } from "node:crypto";
import { isProtectedPath } from "../infrastructure/filesystem/protected-path-policy.js";
import { ConfigurationError } from "../shared/errors.js";

const MAX_CONTENT = 200000;
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

export function createReadFileTool({ fileService, maxChars = MAX_CONTENT } = {}) {
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("read_file requires File Service.");
  return Object.freeze({ name: "read_file", async execute(input = {}, context = {}) {
    const path = safePath(input.path); assertAllowed(path, context); const file = await fileService.readForIndex({ path });
    if (!file || typeof file.content !== "string") throw error("READ_FAILED", `File could not be read: ${path}`);
    const content = file.content.slice(0, maxChars);
    return { path, content, sha256: file.sha256 ?? checksum(file.content), size_bytes: file.size_bytes ?? Buffer.byteLength(file.content), truncated: content.length < file.content.length };
  }});
}

export function createWriteDiffTool({ fileService, maxChars = MAX_CONTENT } = {}) {
  if (typeof fileService?.atomicWrite !== "function" || typeof fileService?.readFile !== "function") throw new ConfigurationError("write_diff requires File Service readFile and atomicWrite.");
  return Object.freeze({ name: "write_diff", async execute(input = {}, context = {}) {
    const path = safePath(input.path, "write"); assertAllowed(path, context); if (typeof input.content !== "string" || input.content.length > maxChars) throw error("CONTENT_INVALID", "content must be a bounded string.");
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
    if (current !== null) { const actual = checksum(current); if (typeof input.before_checksum !== "string" || input.before_checksum !== actual) throw error("CHECKSUM_MISMATCH", `Checksum mismatch for ${path}.`, checksumDiagnostics(input.before_checksum, true)); }
    await fileService.atomicWrite({ path, content: input.content, replace: true });
    return textResult(`Written '${path}' (${checksum(input.content)}).`);
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
    return testService.getTestResult({ jobId: input.job_id.trim(), taskId: context.task_id });
  }});
}

export function createCommitChangesTool({ gitService } = {}) {
  if (typeof gitService?.commit !== "function") throw new ConfigurationError("commit_changes requires Git Service.");
  return Object.freeze({ name: "commit_changes", async execute(input = {}, context = {}) {
    if (typeof input.message !== "string" || !input.message.trim()) throw error("INPUT_INVALID", "Commit message is required.");
    const paths = context.changed_paths ?? context.allowed_file_paths ?? [];
    if (!Array.isArray(paths) || !paths.length) throw error("SCOPE_INVALID", "Node must provide changed_paths for commit.");
    return gitService.commit(input.message, { paths });
  }});
}

export function createReportDoneTool({ reportService } = {}) {
  if (!reportService?.buildFinalReport || !reportService?.saveReport || !reportService?.writeReportFile) throw new ConfigurationError("report_done requires Stage1 Report Service.");
  return Object.freeze({ name: "report_done", async execute(input = {}, context = {}) {
    if (typeof input.summary !== "string" || !input.summary.trim()) throw error("INPUT_INVALID", "Report summary is required.");
    const ticket = context.ticket ?? context.task;
    if (!ticket?.id) throw error("SCOPE_INVALID", "Node must provide the current ticket for report_done.");
    const report = await reportService.buildFinalReport({ ticket, status: context.status ?? "completed", verifyResult: context.verify_result ?? null, filesChanged: context.changed_paths ?? [], reason: "agent_report_done" });
    report.agent_report = { ...(report.agent_report ?? {}), summary: input.summary.trim() };
    await reportService.saveReport(ticket.id, report); await reportService.writeReportFile(ticket.id, report);
    return textResult("Completion report recorded.");
  }});
}

function assertAllowed(path, context) { const allowed = context.allowed_file_paths ?? context.allowedFilePaths; if (Array.isArray(allowed) && !allowed.includes(path)) throw error("PATH_FORBIDDEN", `Path is not approved: ${path}`); }
