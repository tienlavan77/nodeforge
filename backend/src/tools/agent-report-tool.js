// Provides completion reporting for governed agent ticket work.
import { ConfigurationError } from "../shared/errors.js";

const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });

// Creates the governed completion-report tool.
export function createReportDoneTool({ reportService, onEvalCase } = {}) {
  if (!reportService?.buildFinalReport || !reportService?.saveReport || !reportService?.writeReportFile) throw new ConfigurationError("report_done requires Stage1 Report Service.");
  if (onEvalCase !== undefined && typeof onEvalCase !== "function") throw new ConfigurationError("report_done onEvalCase must be a function.");
  return Object.freeze({ name: "report_done", async execute(input = {}, context = {}) {
    if (typeof input.summary !== "string" || !input.summary.trim()) throw error("INPUT_INVALID", "Report summary is required.");
    const ticket = context.ticket ?? context.task;
    if (!ticket?.id) throw error("SCOPE_INVALID", "Node must provide the current ticket for report_done.");
    assertReportScope(ticket, context, input.summary);
    const report = await reportService.buildFinalReport({ ticket, status: context.status ?? "completed", verifyResult: context.verify_result ?? null, filesChanged: context.changed_paths ?? [], reason: "agent_report_done" });
    assertReportVerified(report);
    report.agent_report = { ...(report.agent_report ?? {}), summary: input.summary.trim() };
    await reportService.saveReport(ticket.id, report); await reportService.writeReportFile(ticket.id, report);
    if (typeof onEvalCase === "function") {
      try {
        await onEvalCase({ ticket, report });
      } catch (error) {
        console.log(`[eval-append] skip ${ticket.id}: ${error?.message ?? error}`);
      }
    }
    return { content: [{ type: "text", text: "Completion report recorded." }] };
  }});
}

// Requires completion to cover the sprint leader PATCH files.
function assertReportScope(ticket, context, summary) {
  if (context.lab_mode || context.labMode) return;
  const changed = Array.isArray(context.changed_paths) ? context.changed_paths.filter((path) => typeof path === "string" && path) : [];
  if (changed.length === 1 && changed[0] === "backend/tool-lab-target.txt") throw error("REPORT_SCOPE_INVALID", "Tool-lab marker cannot complete a real ticket.");
  const patchFiles = patchCandidatePaths(ticket);
  const unskipped = patchFiles.filter((path) => !skipReason(summary, path));
  const missing = unskipped.filter((path) => !changed.includes(path));
  if (missing.length) throw error("REPORT_SCOPE_INVALID", `Ticket requires PATCH files ${missing.join(", ")} but they were not changed; edit each file or state in the summary why a file needs no change.`);
  const target = typeof context.target_path === "string" && context.target_path ? context.target_path : null;
  if (target && !changed.includes(target)) throw error("REPORT_SCOPE_INVALID", `Ticket target is ${target} but it was not changed; completion must touch the target file, not an unrelated file in the same prefix.`);
  if (hasUiCriteria(ticket) && !changed.some(isUiPath)) throw error("REPORT_SCOPE_INVALID", "UI ticket cannot be completed without changing a UI file.");
  if (isUiTicket(ticket) && hasBackendCriteria(ticket) && !changed.some(isBackendPath)) throw error("REPORT_SCOPE_INVALID", "Ticket has explicit backend acceptance criteria but no backend file was changed; UI-only work cannot complete it.");
  if (hasBackendCriteria(ticket) && changed.some(isBackendPath) && !changed.some(isBackendImplementationPath)) throw error("REPORT_SCOPE_INVALID", "Backend acceptance criteria require a backend implementation file, not only a backend test or metadata file.");
}

// Blocks completion when verifiable criteria have no Node verification.
function assertReportVerified(report) {
  if (report?.status !== "completed") return;
  const checks = Array.isArray(report.criteria_check) ? report.criteria_check : [];
  const verifiable = checks.filter((item) => /syntax|build|compile|test|lint/i.test(item?.criterion ?? ""));
  if (verifiable.length && verifiable.every((item) => item?.node_verified === null)) throw error("REPORT_UNVERIFIED", "Node did not verify any build/test acceptance criteria; completion report is blocked.");
}

// Identifies tickets whose scope requires UI implementation.
function isUiTicket(ticket) {
  const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter((value) => typeof value === "string").join(" ");
  return /\b(ui|frontend|front-end|react|next(?:\.js)?|component|page|button|layout|watcher|header|screen|responsive|status(?: area| line)?|dashboard|modal)\b/i.test(text);
}

// Collects sprint leader PATCH paths that completion must cover.
function patchCandidatePaths(ticket) {
  const candidates = Array.isArray(ticket?.candidate_files) ? ticket.candidate_files : [];
  return candidates.filter((entry) => entry?.role === "PATCH" && typeof entry?.path === "string" && entry.path).map((entry) => entry.path);
}

// Accepts a skipped PATCH file when the summary names it with a no-change reason.
function skipReason(summary, path) {
  if (typeof summary !== "string" || !summary.includes(path)) return false;
  return /no change|not needed|unnecessary|already (correct|handles|supports)|out of scope/i.test(summary);
}

// Detects explicit backend implementation requirements on a ticket.
function hasBackendCriteria(ticket) {
  return (ticket?.acceptance_criteria ?? []).some((criterion) => {
    if (typeof criterion !== "string") return false;
    if (/\b(backend|back-end|server|endpoint|api|database|db|sqlite|sprint leader|request payload)\b/i.test(criterion)) return true;
    return /\b(persist|persistence)\b/i.test(criterion) && /\b(database|db|sqlite|server|backend|back-end)\b/i.test(criterion);
  });
}

// Detects UI-specific acceptance criteria.
function hasUiCriteria(ticket) {
  return (ticket?.acceptance_criteria ?? []).some((criterion) => typeof criterion === "string" && /\b(ui|frontend|front-end|react|next(?:\.js)?|component|button|layout|watcher|header|screen|responsive|modal|dashboard)\b/i.test(criterion));
}

// Identifies UI implementation paths.
function isUiPath(path) { return path.startsWith("ui/nextjs/") || path.startsWith("ui/src/") || path.startsWith("web/src/"); }

// Identifies backend implementation or test paths.
function isBackendPath(path) { return path.startsWith("backend/src/") || path.startsWith("backend/tests/"); }

// Identifies backend production implementation paths.
function isBackendImplementationPath(path) { return path.startsWith("backend/src/"); }
