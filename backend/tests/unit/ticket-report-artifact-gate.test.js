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
  const verified = createReportDoneTool({ reportService, verificationService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40), commands: [{ kind: "build", exit_code: 0, argv: ["build"] }], file_checksums: { "backend/src/actual.js": "sha256:actual" } }) } });
  await verified.execute({ summary: "Done", acceptance_coverage: [{ criterion: "build", command_kind: "build", test_path: null }] }, context);
  assert.equal(saved, true);
  assert.deepEqual(context.changed_paths, ["backend/src/actual.js"]);
});

// Node fills an omitted criterion as pending evidence instead of rejecting a Coder report.
test("report_done fills omitted criterion coverage with pending evidence", async () => {
  let saved = 0;
  const artifact = { artifact_id: "ARTIFACT-COVERAGE", commit_sha: "a".repeat(40), changed_paths: ["ui/nextjs/app/page.jsx"], file_checksums: { "ui/nextjs/app/page.jsx": "sha256:page" }, commands: [{ kind: "build", exit_code: 0, argv: ["pnpm", "build"] }, { kind: "test", exit_code: 1, argv: ["node", "--test", "ui/nextjs/tests/navigation.test.js"] }] };
  const reportService = { buildFinalReport: async () => ({ status: "submitted_for_review" }), saveReport: async () => { saved++; }, writeReportFile: async () => {} };
  const tool = createReportDoneTool({ reportService, verificationService: { assertPassedArtifact: async () => artifact } });
  const context = { ticket: { id: "T-COVERAGE", acceptance_criteria: ["Build passes", "Navigation works"] } };
  await tool.execute({ summary: "Done", acceptance_coverage: [{ criterion: "Build passes", command_kind: "build", test_path: null }] }, context);
  assert.equal(saved, 1);
  await assert.rejects(tool.execute({ summary: "Done", acceptance_coverage: [{ criterion: "Build passes", command_kind: "build", test_path: null }, { criterion: "Navigation works", command_kind: "build", test_path: null }] }, context), { code: "ACCEPTANCE_COVERAGE_MISSING" });
  await assert.rejects(tool.execute({ summary: "Done", acceptance_coverage: [{ criterion: "Build passes", command_kind: "build", test_path: null }, { criterion: "Navigation works", command_kind: "test", test_path: "ui/nextjs/tests/navigation.test.js" }] }, context), { code: "ACCEPTANCE_COVERAGE_MISSING" });
  assert.equal(saved, 1);
});

// Accepts stable criterion IDs in any order and defers non-command evidence to Reviewer.
test("report_done accepts unordered criterion IDs and pending evidence", async () => {
  const artifact = {
    artifact_id: "ARTIFACT-ID-COVERAGE",
    status: "passed",
    commit_sha: "c".repeat(40),
    changed_paths: ["ui/nextjs/app/page.jsx"],
    file_checksums: { "ui/nextjs/app/page.jsx": "sha256:page" },
    commands: [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", "backend/tests/unit/a.test.js"] }]
  };
  let saved;
  const tool = createReportDoneTool({
    verificationService: { assertPassedArtifact: async () => artifact },
    reportService: {
      buildFinalReport: async ({ status }) => ({ status }),
      saveReport: async (_id, report) => { saved = report; },
      writeReportFile: async () => {}
    }
  });
  const context = { ticket: { id: "T-ID-COVERAGE", acceptance_criteria: ["API behavior works", "Visual layout is reviewed"] } };
  await tool.execute({
    summary: "Implemented the change and submitted visual evidence for review.",
    acceptance_coverage: [
      { criterion_id: "AC-2", status: "evidence_pending" },
      { criterion_id: "AC-1", status: "verified", command_kind: "backend_tests", test_path: "backend/tests/unit/a.test.js" }
    ]
  }, context);
  assert.deepEqual(saved.criteria_check, [
    { criterion: "API behavior works", criterion_id: "AC-1", node_verified: true, status: "verified", command_kind: "backend_tests", test_path: "backend/tests/unit/a.test.js", artifact_id: artifact.artifact_id },
    { criterion: "Visual layout is reviewed", criterion_id: "AC-2", node_verified: false, status: "evidence_pending", command_kind: null, test_path: null, artifact_id: artifact.artifact_id }
  ]);
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

// Persists a Coder's scoped explanation as the completion record without an inline Reviewer gate.
test("report_done saves a structured completion explanation", async () => {
  const artifact = { artifact_id: "ARTIFACT-S", status: "passed", commit_sha: "a".repeat(40), source_revision: "source-s", changed_paths: ["backend/src/a.js"], file_checksums: { "backend/src/a.js": "sha256:a", "backend/src/b.js": "sha256:b" }, commands: [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", "backend/tests/unit/a.test.js"] }] };
  let persisted;
  let report;
  const tool = createReportDoneTool({
    verificationService: { assertPassedArtifact: async () => artifact },
    reviewFindings: { recordCoderReportDraft: async ({ report }) => report, recordCoderReport: async (entry) => { persisted = entry; } },
    reportService: { buildFinalReport: async ({ status }) => ({ status, criteria_check: [] }), saveReport: async (_id, value) => { report = value; }, writeReportFile: async () => {} }
  });
  const explanation = { summary: "Changed one backend file.", acceptance_coverage: [{ criterion: "API returns the result", command_kind: "backend_tests", test_path: "backend/tests/unit/a.test.js" }], implementation_scope: { changed_files: ["backend/src/a.js"], not_changed_files: ["backend/src/b.js"], scope_rationale: "The second file already implements its part." }, evidence: [{ type: "verification", reference: artifact.artifact_id, result: "passed" }], reviewer_notes: [{ topic: "Unchanged file", position: "No edit needed", rationale: "Existing behavior covers it.", evidence_refs: [artifact.artifact_id] }] };
  await tool.execute(explanation, { ticket: { id: "TICKET-S", acceptance_criteria: ["API returns the result"] } });
  assert.equal(persisted.report.summary, explanation.summary);
  assert.deepEqual(persisted.report.acceptance_criteria, ["API returns the result"]);
  assert.deepEqual(persisted.report.acceptance_coverage, [{ criterion: "API returns the result", criterion_id: "AC-1", status: "verified", command_kind: "backend_tests", test_path: "backend/tests/unit/a.test.js" }]);
  assert.equal(persisted.artifact.artifact_id, artifact.artifact_id);
  assert.equal(report.status, "submitted_for_review");
  assert.deepEqual(report.files_changed, undefined);
});

// Node completes deterministic evidence on the first Coder summary and keeps it immutable.
test("report_done completes source and command evidence without Coder field duplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-report-supplement-"));
  try {
    const artifact = { artifact_id: "ARTIFACT-SUP", status: "passed", commit_sha: "a".repeat(40), source_revision: "source-sup", manifest_sha: "manifest-sup", changed_paths: ["backend/src/a.js"], file_checksums: { "backend/src/a.js": "sha256:a" }, commands: [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", "backend/tests/unit/a.test.js"] }] };
    const store = () => createTicketReviewFindingsStore({ taskId: "TICKET-SUP", fileService: createFileService({ projectRoot: root }), executionContexts: { load: async () => ({ verification_artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha }) } });
    let saved = 0;
    const tool = () => createReportDoneTool({ reviewFindings: store(), verificationService: { assertPassedArtifact: async () => artifact }, reportService: { buildFinalReport: async ({ status }) => ({ status, criteria_check: [] }), saveReport: async () => { saved++; }, writeReportFile: async () => {} } });
    const context = { ticket: { id: "TICKET-SUP", acceptance_criteria: ["API works"] } };
    await tool().execute({ summary: "Original report" }, context);
    const history = await store().load();
    assert.equal(history.coder_reports.length, 1);
    assert.equal(history.coder_reports[0].report.summary, "Original report");
    assert.deepEqual(history.coder_reports[0].report.implementation_scope.changed_files, ["backend/src/a.js"]);
    assert.equal(history.coder_reports[0].report.acceptance_coverage[0].status, "evidence_pending");
    assert.equal(history.coder_reports[0].report.evidence[0].reference, artifact.artifact_id);
    assert.equal(saved, 1);
    await tool().execute({ summary: "Original report" }, context);
    assert.equal((await store().load()).coder_reports.length, 1);
    await assert.rejects(tool().execute({ summary: "Rewritten report" }, context), { code: "CODER_REPORT_CONFLICT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A missing artifact triggers Node verification while a failing job still blocks the report.
test("report_done waits for Node verification and never persists failed evidence", async () => {
  let saved = 0;
  let report;
  let verified = 0;
  const artifact = { artifact_id: "ARTIFACT-AUTO", commit_sha: "a".repeat(40), changed_paths: ["backend/src/a.js"], file_checksums: { "backend/src/a.js": "sha256:a" }, commands: [{ kind: "lint", exit_code: 0, argv: ["pnpm", "lint"] }] };
  const reportService = { buildFinalReport: async () => ({ status: "completed" }), saveReport: async (_id, value) => { saved++; report = value; }, writeReportFile: async () => {} };
  const context = { ticket: { id: "T-AUTO", acceptance_criteria: ["Lint passes", "Lint passes and the UI behaves correctly"] } };
  const tool = createReportDoneTool({ reportService, verificationService: { ensurePassedArtifact: async () => { verified++; return artifact; } } });
  await tool.execute({ summary: "Fixed lint" }, context);
  assert.equal(verified, 1);
  assert.equal(saved, 1);
  assert.deepEqual(report.criteria_check.map((entry) => entry.status), ["verified", "evidence_pending"]);
  const blocked = createReportDoneTool({ reportService, verificationService: { ensurePassedArtifact: async () => { throw Object.assign(new Error("failed"), { code: "VERIFY_FAILED" }); } } });
  await assert.rejects(blocked.execute({ summary: "Done" }, context), { code: "VERIFY_FAILED" });
  assert.equal(saved, 1);
});

// A response to old findings cannot replace the first explanation for a new artifact.
test("respond_to_review cannot bypass a missing report for the current artifact", async () => {
  let responses = 0;
  const artifact = { artifact_id: "ARTIFACT-NEW", commit_sha: "b".repeat(40), source_revision: "source-new" };
  const tool = createRespondToReviewTool({ verificationService: { assertPassedArtifact: async () => artifact }, reviewFindings: { load: async () => ({ coder_reports: [{ artifact_id: "ARTIFACT-OLD", review_commit_sha: "a".repeat(40) }] }), recordResponse: async () => { responses++; } } });
  await assert.rejects(tool.execute({ artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision }, {}), { code: "CODER_EXPLANATION_MISSING" });
  assert.equal(responses, 0);
});
