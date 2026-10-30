// Exercises durable report publication across blocker overwrite, process restart and source-bound review recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionReportService } from "../../src/modules/supervisor/completion-report-service.js";
import { createCoderReportRecovery } from "../../src/modules/supervisor/coder/coder-report-recovery.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";

// Retains independent immutable and presentation stores while reconstructing the production report services.
function fixture() {
  const taskId = "TICKET-REPORT";
  const ticket = { id: taskId, title: "Lint source", objective: "Validate the ticket source", acceptance_criteria: ["Lint passes"] };
  const artifact = { status: "passed", artifact_id: "ARTIFACT", commit_sha: "a".repeat(40), source_revision: "sha256:source", manifest_sha: "sha256:manifest",
    changed_paths: ["backend/src/a.js"], file_checksums: { "backend/src/a.js": "sha256:a" }, commands: [{ kind: "lint", exit_code: 0 }] };
  const context = { task_id: taskId, verification_artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha,
    source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, verification_plan: [] };
  const records = new Map();
  const files = new Map();
  const history = { coder_reports: [] };
  const logs = [];
  const reviewFindings = { load: async () => structuredClone(history), recordCoderReportDraft: async ({ report }) => report,
    recordCoderReport: async ({ report, artifact, idempotencyKey }) => {
      history.coder_reports.push({ task_id: taskId, idempotency_key: idempotencyKey, artifact_id: artifact.artifact_id,
        review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, report: structuredClone(report) });
    } };
  const testService = { assertPassedArtifact: async () => structuredClone(artifact) };
  const protocolStorage = {
    get: async (key) => {
      if (!records.has(key)) throw Object.assign(new Error("Report missing"), { code: "ENOENT" });
      return { data: structuredClone(records.get(key)) };
    }, save: async (key, report) => { records.set(key, structuredClone(report)); }
  };
  const options = { protocolStorage, fileService: { atomicWrite: async ({ path, content }) => { files.set(path, content); } },
    recoverCoderReport: createCoderReportRecovery({ taskId, reviewFindings, testService, executionContexts: { load: async () => context },
      projectLogger: (event) => logs.push(event) }) };
  const recreate = () => createCompletionReportService(options);
  const service = recreate();
  const tool = createReportDoneTool({ reportService: service, verificationService: testService, reviewFindings });
  const report = { summary: "Original explanation", acceptance_coverage: [{ criterion_id: "AC-1", status: "verified", command_kind: "lint" }],
    implementation_scope: { changed_files: artifact.changed_paths, not_changed_files: [], scope_rationale: "Only the ticket source changed" },
    evidence: [{ type: "verification", reference: artifact.artifact_id, result: "passed" }] };
  const key = `task/${taskId}/final_report`;
  return { taskId, ticket, artifact, context, history, records, files, logs, recreate, service, tool, report, key };
}

// Submits the actual report tool before testing the same blocked and needs-context calls used by agents.
test("operational reports never overwrite the submitted report or its Markdown", async () => {
  const f = fixture();
  await f.tool.execute(f.report, { ticket: f.ticket });
  const submitted = structuredClone(f.records.get(f.key));
  const markdown = f.files.get(`.forge/runtime/reports/${f.taskId}.md`);
  for (const input of [
    { status: "blocked", summary: "Report delivery is blocked", blocker: { reason_code: "ACCESS_REQUIRED", owner_action: "Reconcile report delivery" }, evidence: ["backend/src/a.js:1"] },
    { status: "needs_context", summary: "Inspect retained review history" }
  ]) {
    await assert.rejects(f.tool.execute(input, { ticket: f.ticket }), { code: input.status === "blocked" ? "CODER_BLOCKED" : "CODER_NEEDS_CONTEXT" });
    assert.deepEqual(f.records.get(f.key), submitted);
    assert.equal(f.files.get(`.forge/runtime/reports/${f.taskId}.md`), markdown);
    assert.equal(f.records.get(`task/${f.taskId}/operational_report`).status, "needs_human_review");
  }
  assert.equal((await f.recreate().assertCoderReport(f.taskId, f.ticket)).status, "submitted_for_review");
  assert.equal(f.logs.length, 0);
});

// Reproduces the real legacy overwrite and a crash after immutable publication but before final_report persistence.
for (const missing of [false, true]) {
  test(`restart restores ${missing ? "missing" : "overwritten"} final_report from the exact immutable report`, async () => {
    const f = fixture();
    await f.tool.execute(f.report, { ticket: f.ticket });
    const history = structuredClone(f.history);
    if (missing) f.records.delete(f.key);
    else f.records.set(f.key, { ticket: f.ticket, status: "needs_human_review", reason: "coder_blocked", criteria_check: [] });
    const restored = await f.recreate().assertCoderReport(f.taskId, f.ticket);
    assert.equal(restored.status, "submitted_for_review");
    assert.equal(restored.agent_report.summary, f.report.summary);
    assert.equal(restored.verify_result.artifact_id, f.artifact.artifact_id);
    assert.equal(restored.criteria_check[0].status, "verified");
    assert.deepEqual(f.history, history);
    await f.recreate().assertCoderReport(f.taskId, f.ticket);
    assert.equal(f.logs.length, 1);
    assert.equal((await f.recreate().completeAcceptedReport(f.taskId)).status, "completed");
  });
}

// Keeps old artifacts, different tickets, lost reports and missing acceptance evidence out of independent review.
test("recovery rejects changed report/source identities and never manufactures missing evidence", async () => {
  for (const failure of ["artifact", "source", "manifest", "commit", "missing", "coverage", "criteria"]) {
    const f = fixture();
    await f.tool.execute(f.report, { ticket: f.ticket });
    f.records.set(f.key, { ticket: f.ticket, status: "needs_human_review", criteria_check: [] });
    if (failure === "artifact") f.artifact.artifact_id = "OTHER";
    if (failure === "source") f.artifact.source_revision = "OTHER";
    if (failure === "manifest") f.artifact.manifest_sha = "OTHER";
    if (failure === "commit") f.artifact.commit_sha = "b".repeat(40);
    if (failure === "missing") f.history.coder_reports = [];
    if (failure === "coverage") f.history.coder_reports[0].report.acceptance_coverage[0].status = "evidence_pending";
    if (failure === "criteria") f.ticket.acceptance_criteria = ["Different approved work"];
    await assert.rejects(f.recreate().assertCoderReport(f.taskId, f.ticket));
    assert.equal(f.records.get(f.key).status, "needs_human_review");
    assert.equal(f.logs.length, 0);
  }
});
