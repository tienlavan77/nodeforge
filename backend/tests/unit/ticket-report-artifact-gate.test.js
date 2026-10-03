// Ensures an agent completion report cannot bypass Node-owned ticket verification.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";
import { createRespondToReviewTool } from "../../src/tools/respond-to-review-tool.js";

// Blocks report persistence if the ticket artifact is absent or mismatched.
test("report_done requires a passed artifact before saving a ticket report", async () => {
  let saved = false;
  const reportService = {
    buildFinalReport: async ({ verifyResult, filesChanged }) => ({ status: "completed", ticket: { id: "TICKET-1" }, criteria_check: [{ criterion: "build", node_verified: Boolean(verifyResult?.ready_for_review) }], files_changed: filesChanged }),
    saveReport: async () => { saved = true; },
    writeReportFile: async () => {}
  };
  const context = { ticket: { id: "TICKET-1", acceptance_criteria: ["build"] }, changed_paths: ["backend/src/agent-claimed.js"] };
  const blocked = createReportDoneTool({ reportService, verificationService: { assertPassedArtifact: async () => { throw Object.assign(new Error("missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); } } });
  await assert.rejects(blocked.execute({ summary: "Done" }, context), { code: "VERIFY_ARTIFACT_MISMATCH" });
  assert.equal(saved, false);
  const verified = createReportDoneTool({ reportService, verificationService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40), file_checksums: { "backend/src/actual.js": "sha256:actual" } }) } });
  await verified.execute({ summary: "Done" }, context);
  assert.equal(saved, true);
  assert.deepEqual(context.changed_paths, ["backend/src/actual.js"]);
});

// Keeps backend remediation reports from being classified as UI work by test names.
test("report_done respects implementation_type when criteria mention UI tests", async () => {
  const reportService = {
    buildFinalReport: async () => ({ status: "completed", criteria_check: [] }),
    saveReport: async () => {},
    writeReportFile: async () => {}
  };
  const tool = createReportDoneTool({ reportService });
  const context = { ticket: { id: "BACKEND-1", implementation_type: ["backend"], acceptance_criteria: ["Watcher UI scope test passes on the backend baseline."] }, changed_paths: ["backend/src/application/test-service.js"] };
  await tool.execute({ summary: "Backend baseline verified." }, context);
  await assert.rejects(
    tool.execute({ summary: "UI complete." }, { ...context, ticket: { ...context.ticket, implementation_type: ["frontend"] } }),
    { code: "REPORT_SCOPE_INVALID" }
  );
});

// Persists a Coder's scoped explanation for Reviewer inspection without claiming ticket acceptance.
test("report_done saves a structured explanation as a review submission", async () => {
  const artifact = { artifact_id: "ARTIFACT-S", status: "passed", commit_sha: "a".repeat(40), source_revision: "source-s", changed_paths: ["backend/src/a.js"], file_checksums: { "backend/src/a.js": "sha256:a", "backend/src/b.js": "sha256:b" } };
  let persisted;
  let report;
  const tool = createReportDoneTool({
    verificationService: { assertPassedArtifact: async () => artifact },
    reviewFindings: { recordCoderReportDraft: async ({ report }) => report, recordCoderReport: async (entry) => { persisted = entry; } },
    reportService: { buildFinalReport: async ({ status }) => ({ status, criteria_check: [] }), saveReport: async (_id, value) => { report = value; }, writeReportFile: async () => {} }
  });
  const explanation = { summary: "Changed one backend file.", acceptance_criteria: ["API returns the result"], implementation_scope: { changed_files: ["backend/src/a.js"], not_changed_files: ["backend/src/b.js"], scope_rationale: "The second file already implements its part." }, evidence: [{ type: "verification", reference: artifact.artifact_id, result: "passed" }], reviewer_notes: [{ topic: "Unchanged file", position: "No edit needed", rationale: "Existing behavior covers it.", evidence_refs: [artifact.artifact_id] }] };
  await tool.execute(explanation, { ticket: { id: "TICKET-S", acceptance_criteria: ["API returns the result"] } });
  assert.deepEqual(persisted.report, explanation);
  assert.equal(persisted.artifact.artifact_id, artifact.artifact_id);
  assert.equal(report.status, "submitted_for_review");
  assert.deepEqual(report.files_changed, undefined);
});

// A partial report survives restart and a later call supplies only missing explanation fields.
test("report_done supplements the saved original without rewriting its summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-report-supplement-"));
  try {
    const artifact = { artifact_id: "ARTIFACT-SUP", status: "passed", commit_sha: "a".repeat(40), source_revision: "source-sup", manifest_sha: "manifest-sup", changed_paths: ["backend/src/a.js"], file_checksums: { "backend/src/a.js": "sha256:a" } };
    const store = () => createTicketReviewFindingsStore({ taskId: "TICKET-SUP", fileService: createFileService({ projectRoot: root }), executionContexts: { load: async () => ({ verification_artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha }) } });
    let saved = 0;
    const tool = () => createReportDoneTool({ reviewFindings: store(), verificationService: { assertPassedArtifact: async () => artifact }, reportService: { buildFinalReport: async ({ status }) => ({ status, criteria_check: [] }), saveReport: async () => { saved++; }, writeReportFile: async () => {} } });
    const context = { ticket: { id: "TICKET-SUP", acceptance_criteria: ["API works"] } };
    await assert.rejects(tool().execute({ summary: "Original report" }, context), { code: "CODER_EXPLANATION_REQUIRED" });
    assert.equal((await store().load()).coder_report_drafts[0].report.summary, "Original report");
    assert.equal(saved, 0);
    await assert.rejects(tool().execute({ acceptance_criteria: ["Paraphrased criterion"] }, context), { code: "CODER_EXPLANATION_REQUIRED" });
    const supplement = { acceptance_criteria: ["API works"], implementation_scope: { changed_files: ["backend/src/a.js"], not_changed_files: [], scope_rationale: "Only this file changed." }, evidence: [{ type: "test", reference: "ARTIFACT-SUP", result: "passed" }], reviewer_notes: [] };
    await tool().execute(supplement, context);
    const history = await store().load();
    assert.equal(history.coder_reports.length, 1);
    assert.equal(history.coder_reports[0].report.summary, "Original report");
    assert.equal(history.coder_report_drafts[0].original_report.summary, "Original report");
    assert.deepEqual(history.coder_report_drafts[0].submissions[1].report.acceptance_criteria, ["Paraphrased criterion"]);
    assert.equal(saved, 1);
    await tool().execute(supplement, context);
    assert.equal((await store().load()).coder_reports.length, 1);
    await assert.rejects(tool().execute({ summary: "Rewritten report" }, context), { code: "CODER_REPORT_CONFLICT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A response to old findings cannot replace the first explanation for a new artifact.
test("respond_to_review cannot bypass a missing report for the current artifact", async () => {
  let responses = 0;
  const artifact = { artifact_id: "ARTIFACT-NEW", commit_sha: "b".repeat(40), source_revision: "source-new" };
  const tool = createRespondToReviewTool({ verificationService: { assertPassedArtifact: async () => artifact }, reviewFindings: { load: async () => ({ coder_reports: [{ artifact_id: "ARTIFACT-OLD", review_commit_sha: "a".repeat(40) }] }), recordResponse: async () => { responses++; } } });
  await assert.rejects(tool.execute({ artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision }, {}), { code: "CODER_EXPLANATION_MISSING" });
  assert.equal(responses, 0);
});
