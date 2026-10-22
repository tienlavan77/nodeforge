// Restores a submitted Coder report from immutable verified evidence after an operational blocker overwrote its projection.
import { createReportDoneTool } from "../../tools/agent-report-tool.js";
import { readCompletedCoderReport } from "../../tools/completed-coder-report.js";
import { isDeepStrictEqual } from "node:util";

// Replays Node-owned report publication without another agent turn, source edit, commit or verification run.
export function createCoderReportRecovery({ taskId, reviewFindings, testService, executionContexts, projectLogger = () => {} }) {
  return async (requestedTaskId, current, reportService, approvedTicket) => {
    if (requestedTaskId !== taskId) throw Object.assign(new Error("Coder report recovery belongs to a different ticket."), { code: "REPORT_SCOPE_INVALID" });
    const artifact = await testService.assertPassedArtifact();
    const report = await readCompletedCoderReport({ reviewFindings, artifact, input: {} });
    if (!report) throw Object.assign(new Error("No completed Coder report matches the current verified artifact."), { code: "AGENT_REPORT_MISSING" });
    if (approvedTicket && (approvedTicket.id !== taskId || !isDeepStrictEqual(approvedTicket.acceptance_criteria, report.acceptance_criteria)))
      throw Object.assign(new Error("The completed Coder report differs from the approved ticket criteria."), { code: "CODER_REPORT_CONFLICT" });
    const coverage = report.acceptance_coverage ?? [];
    const matchesCoverage = current?.criteria_check?.length === coverage.length && coverage.every((entry, index) => {
      const projected = current.criteria_check[index];
      return ["criterion_id", "criterion", "status"].every((key) => projected[key] === entry[key])
        && projected.artifact_id === artifact.artifact_id;
    });
    if (["submitted_for_review", "completed"].includes(current?.status) && current.verify_result?.artifact_id === artifact.artifact_id
      && current.verify_result?.commit_id === artifact.commit_sha && matchesCoverage
      && Object.entries(report).every(([key, value]) => isDeepStrictEqual(current.agent_report?.[key], value))) return current;
    const context = await executionContexts.load(taskId);
    if (context?.task_id !== taskId || context.verification_artifact_id !== artifact.artifact_id
      || context.review_commit_sha !== artifact.commit_sha || context.source_revision !== artifact.source_revision || context.manifest_sha !== artifact.manifest_sha)
      throw Object.assign(new Error("Report recovery differs from the current verified ticket source."), { code: "REVIEW_EVIDENCE_MISMATCH" });
    const ticket = approvedTicket ?? { ...current?.ticket, id: taskId, acceptance_criteria: report.acceptance_criteria,
      verification_plan: context.verification_plan ?? [] };
    if (!ticket.title || !ticket.objective)
      throw Object.assign(new Error("Report recovery requires the original ticket metadata."), { code: "REPORT_METADATA_MISSING" });
    if (!Array.isArray(ticket.acceptance_criteria) || !ticket.acceptance_criteria.length)
      throw Object.assign(new Error("The retained Coder report has no acceptance criteria to recover."), { code: "ACCEPTANCE_COVERAGE_MISSING" });
    let restored;
    const publisher = { ...reportService, saveReport: async (id, value) => { await reportService.saveReport(id, value); restored = value; } };
    await createReportDoneTool({ reportService: publisher, verificationService: { assertPassedArtifact: () => testService.assertPassedArtifact() }, reviewFindings })
      .execute({}, { ticket });
    projectLogger({ event_name: "ticket.coder_report_restored", level: "info", status: "success", task_id: taskId,
      message: "Submitted Coder report restored from the immutable report on the current verified artifact.",
      payload: { artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, source_revision: artifact.source_revision } });
    return restored;
  };
}
