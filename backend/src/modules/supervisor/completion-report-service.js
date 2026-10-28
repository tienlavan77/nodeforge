// Builds and persists Supervisor completion reports from Node-owned ticket artifacts.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { ConfigurationError } from "../../shared/errors.js";

/** Builds and persists the owner-facing report from Node-owned artifacts. */
export function createCompletionReportService({ protocolStorage, fileService, gitService, recoverCoderReport } = {}) {
  if (typeof protocolStorage?.save !== "function" || typeof protocolStorage?.get !== "function") throw new ConfigurationError("Report service requires Protocol Storage.");
  if (typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Report service requires File Service.");
  const service = Object.freeze({ buildFinalReport, saveReport, writeReportFile, completeAcceptedReport, assertCoderReport, completeCoderReport, getCommitsForTask });
  return service;

  // Defines getCommitsForTask function behavior for completion-report-service.js.
  async function getCommitsForTask(taskId) { return typeof gitService?.getCommitsForTask === "function" ? gitService.getCommitsForTask(taskId) : []; }

  // Defines buildFinalReport function behavior for completion-report-service.js.
  async function buildFinalReport({ ticket, status, verifyResult = null, filesChanged = [], reason = null, error = null } = {}) {
    if (!ticket?.id) throw new ConfigurationError("Final report requires ticket.");
    let agentReport = null;
    // eslint-disable-next-line no-silent-catch -- Agent report is optional on abnormal stops.
    try { agentReport = (await protocolStorage.get(`task/${ticket.id}/report`)).data; } catch { /* report is optional on abnormal stops */ }
    const commits = await getCommitsForTask(ticket.id);
    const verified = (ticket.acceptance_criteria ?? []).map((criterion) => ({ criterion, node_verified: /syntax|build|compile|test|lint/i.test(criterion) && verifyResult ? Boolean(verifyResult.pass ?? verifyResult.ready_for_review) : null }));
    return { ticket: { id: ticket.id, title: ticket.title, objective: ticket.objective }, status: status ?? null, reason, error, agent_report: agentReport, verify_result: verifyResult, files_changed: filesChanged, commits, criteria_check: verified, generated_at: new Date().toISOString() };
  }

  // Defines saveReport function behavior for completion-report-service.js.
  async function saveReport(taskId, report) {
    const name = recoverCoderReport && !["submitted_for_review", "completed"].includes(report.status) ? "operational_report" : "final_report";
    return protocolStorage.save(`task/${taskId}/${name}`, report, { schemaId: "https://forge.local/schemas/agent/final-report.schema.json", replace: true });
  }
  // Promotes a submitted Coder explanation only after independent approval and integration.
  async function completeAcceptedReport(taskId) {
    const current = await assertCoderReport(taskId);
    if (current.status === "completed") return current;
    if (current.status !== "submitted_for_review") throw new ConfigurationError("Accepted report requires a submitted Coder explanation.");
    const completed = { ...current, status: "completed", reason: "reviewer_approved", generated_at: new Date().toISOString() };
    await saveReport(taskId, completed);
    await writeReportFile(taskId, completed);
    return completed;
  }
  // Requires every criterion to have a normalized Coder coverage status before integration.
  async function assertCoderReport(taskId, ticket) {
    let current;
    try { current = (await protocolStorage.get(`task/${taskId}/final_report`)).data; }
    catch (error) { if (!recoverCoderReport || error.code !== "ENOENT") throw error; }
    if (recoverCoderReport) current = await recoverCoderReport(taskId, current, service, ticket);
    if (current.status !== "submitted_for_review" && current.status !== "completed") throw new ConfigurationError("Coder completion requires a submitted report.");
    assertCoderCoverage(current.criteria_check);
    return current;
  }
  // Promotes a verified Coder report when ticket execution does not require inline review.
  async function completeCoderReport(taskId) {
    const current = await assertCoderReport(taskId);
    if (current.status === "completed") return current;
    const completed = { ...current, status: "completed", reason: "coder_verified", generated_at: new Date().toISOString() };
    await saveReport(taskId, completed);
    await writeReportFile(taskId, completed);
    return completed;
  }
  // Defines writeReportFile function behavior for completion-report-service.js.
  async function writeReportFile(taskId, report) {
    const markdown = renderMarkdown(report);
    const suffix = recoverCoderReport && !["submitted_for_review", "completed"].includes(report.status) ? ".operational" : "";
    return fileService.atomicWrite({ path: `${statePath()}/reports/${taskId}${suffix}.md`, content: markdown, replace: true });
  }
}

// Blocks successful completion reporting until every criterion has sufficient verification evidence.
export function assertCoderCoverage(coverage) {
  const validStatuses = new Set(["verified", "evidence_pending", "not_applicable"]);
  if (!Array.isArray(coverage) || coverage.some((entry) => !validStatuses.has(entry.status) && entry.node_verified !== true)) throw new ConfigurationError("Coder completion requires normalized coverage for every acceptance criterion.");
  const pending = coverage.filter((entry) => entry.status === "evidence_pending");
  if (pending.length) {
    const criterionIds = pending.map((entry) => entry.criterion_id).filter(Boolean);
    const missingChecks = pending.flatMap((entry) => (entry.missing_checks ?? []).map((check) => ({ criterion_id: entry.criterion_id, ...check })));
    const unsupported = [...new Set(missingChecks.filter((check) => check.kind === "human").map((check) => check.kind))];
    const diagnostic = missingChecks.length ? ` Missing checks: ${missingChecks.map((check) => `${check.criterion_id}:${check.kind}${check.test_path ? ` (${check.test_path})` : ""}`).join(", ")}.` : "";
    const action = unsupported.length ? ` The ticket verification runner does not execute ${unsupported.join(", ")} checks. Node verification support or an owner-approved plan revision is required; repeating report_done cannot supply this evidence.` : " Run the required checks and retry report_done with verified criterion coverage; do not report completion yet.";
    throw Object.assign(new ConfigurationError(`Completion is blocked by missing acceptance evidence.${diagnostic}${action}`), { code: "CODER_EVIDENCE_PENDING", details: { criterion_ids: criterionIds, ...(missingChecks.length ? { missing_checks: missingChecks } : {}), ...(unsupported.length ? { unsupported_check_kinds: unsupported } : {}) } });
  }
}

// Defines renderMarkdown function behavior for completion-report-service.js.
function renderMarkdown(report) {
  const lines = [`# ${report.ticket.id}: ${report.ticket.title}`, "", `- Status: ${report.status ?? "unknown"}`, `- Generated: ${report.generated_at}`];
  if (report.reason) lines.push(`- Reason: ${report.reason}`);
  if (report.error) lines.push(`- Error: ${report.error}`);
  lines.push("", "## Objective", report.ticket.objective, "", "## Files Changed", ...(report.files_changed?.length ? report.files_changed.map((file) => `- ${typeof file === "string" ? file : file.path}`) : ["- None"]), "", "## Commits", ...(report.commits?.length ? report.commits.map((commit) => `- ${commit.sha}: ${commit.subject}`) : ["- None"]), "", "## Acceptance Criteria", ...report.criteria_check.map((item) => `- [${item.node_verified === true || item.status === "verified" ? "x" : " "}] ${item.criterion}${item.status === "evidence_pending" ? " (evidence pending)" : item.status === "not_applicable" ? " (not applicable)" : item.node_verified === null ? " (not measured by Node)" : ""}`));
  return `${lines.join("\n")}\n`;
}
