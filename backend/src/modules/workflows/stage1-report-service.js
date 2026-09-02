import { ConfigurationError } from "../../shared/errors.js";

/** Builds and persists the owner-facing report from Node-owned artifacts. */
export function createStage1ReportService({ protocolStorage, fileService, gitService } = {}) {
  if (typeof protocolStorage?.save !== "function" || typeof protocolStorage?.get !== "function") throw new ConfigurationError("Report service requires Protocol Storage.");
  if (typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Report service requires File Service.");
  return Object.freeze({ buildFinalReport, saveReport, writeReportFile, getCommitsForTask });

  async function getCommitsForTask(taskId) { return typeof gitService?.getCommitsForTask === "function" ? gitService.getCommitsForTask(taskId) : []; }

  async function buildFinalReport({ ticket, status, verifyResult = null, filesChanged = [], reason = null, error = null } = {}) {
    if (!ticket?.id) throw new ConfigurationError("Final report requires ticket.");
    let agentReport = null;
    try { agentReport = (await protocolStorage.get(`task/${ticket.id}/report`)).data; } catch { /* report is optional on abnormal stops */ }
    const commits = await getCommitsForTask(ticket.id);
    const verified = ticket.acceptance_criteria.map((criterion) => ({ criterion, node_verified: /syntax|build|compile|test|lint/i.test(criterion) && verifyResult ? Boolean(verifyResult.pass ?? verifyResult.ready_for_review) : null }));
    return { ticket: { id: ticket.id, title: ticket.title, objective: ticket.objective }, status: status ?? null, reason, error, agent_report: agentReport, verify_result: verifyResult, files_changed: filesChanged, commits, criteria_check: verified, generated_at: new Date().toISOString() };
  }

  async function saveReport(taskId, report) { return protocolStorage.save(`task/${taskId}/final_report`, report, { schemaId: "https://forge.local/schemas/agent/final-report.schema.json" }); }
  async function writeReportFile(taskId, report) {
    const markdown = renderMarkdown(report);
    return fileService.atomicWrite({ path: `.forge/runtime/reports/${taskId}.md`, content: markdown, replace: true });
  }
}

function renderMarkdown(report) {
  const lines = [`# ${report.ticket.id}: ${report.ticket.title}`, "", `- Status: ${report.status ?? "unknown"}`, `- Generated: ${report.generated_at}`];
  if (report.reason) lines.push(`- Reason: ${report.reason}`);
  if (report.error) lines.push(`- Error: ${report.error}`);
  lines.push("", "## Objective", report.ticket.objective, "", "## Files Changed", ...(report.files_changed?.length ? report.files_changed.map((file) => `- ${typeof file === "string" ? file : file.path}`) : ["- None"]), "", "## Commits", ...(report.commits?.length ? report.commits.map((commit) => `- ${commit.sha}: ${commit.subject}`) : ["- None"]), "", "## Acceptance Criteria", ...report.criteria_check.map((item) => `- [${item.node_verified === true ? "x" : " "}] ${item.criterion}${item.node_verified === null ? " (not measured by Node)" : ""}`));
  return `${lines.join("\n")}\n`;
}
