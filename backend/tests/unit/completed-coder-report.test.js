// Covers immutable report replay and the separate finding-response route on unchanged verified source.
import test from "node:test";
import assert from "node:assert/strict";
import { readCompletedCoderReport } from "../../src/tools/completed-coder-report.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";
import { createRespondToReviewTool } from "../../src/tools/respond-to-review-tool.js";

// Seeds an exact completed report whose custom scope and evidence must survive default generation.
function fixture() {
  const artifact = { artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40), source_revision: "sha256:source", manifest_sha: "sha256:manifest",
    file_checksums: { "backend/src/a.js": "sha256:a" }, changed_paths: ["backend/src/a.js"], commands: [{ kind: "lint", exit_code: 0 }] };
  const report = { summary: "Original completed report", acceptance_criteria: ["Lint passes"],
    acceptance_coverage: [{ criterion_id: "AC-1", criterion: "Lint passes", status: "verified", command_kind: "lint" }],
    implementation_scope: { changed_files: ["backend/src/a.js"], not_changed_files: [], scope_rationale: "Original precise explanation" },
    evidence: [{ type: "verification", reference: artifact.artifact_id, result: "passed" }],
    reviewer_notes: [{ topic: "REV-2", position: "dispute", rationale: "Already verified", evidence_refs: [artifact.artifact_id] }] };
  const entry = { idempotency_key: "ARTIFACT-1:report", artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha,
    source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, report };
  const history = { coder_reports: [entry], findings: [{ finding_id: "REV-2", status: "open" }], coder_responses: [] };
  const writes = [];
  const reviewFindings = { load: async () => history, recordCoderReportDraft: async () => { throw new Error("Must not rewrite draft"); },
    recordCoderReport: async () => { throw new Error("Must not rewrite report"); }, recordResponse: async (response) => { history.coder_responses.push(response); return response; } };
  const verificationService = { assertPassedArtifact: async () => artifact };
  const tool = createReportDoneTool({ reviewFindings, verificationService, reportService: { buildFinalReport: async ({ status }) => ({ status }),
    saveReport: async (_id, value) => writes.push(value), writeReportFile: async () => {} } });
  return { artifact, report, history, reviewFindings, verificationService, tool, writes };
}

test("report_done empty or identical partial replay preserves the completed scope and skips draft persistence", async () => {
  const f = fixture(), before = structuredClone(f.history);
  const context = { ticket: { id: "TICKET-1", acceptance_criteria: ["Lint passes"] } };
  for (const input of [{}, { summary: f.report.summary }, { implementation_scope: { scope_rationale: f.report.implementation_scope.scope_rationale } }]) {
    await f.tool.execute(input, context);
    assert.deepEqual(f.writes.at(-1).agent_report, f.report);
  }
  assert.deepEqual(f.history, before);
});

test("changed explanation or a stale artifact cannot overwrite an immutable report", async () => {
  const f = fixture();
  for (const input of [{ summary: "Changed" }, { reviewer_notes: [] }, { implementation_scope: { changed_files: [] } }])
    await assert.rejects(readCompletedCoderReport({ ...f, input }), (error) => error.code === "CODER_REPORT_CONFLICT" && /respond_to_review/.test(error.message));
  await assert.rejects(readCompletedCoderReport({ ...f, input: {}, artifact: { ...f.artifact, source_revision: "different" } }), { code: "CODER_REPORT_CONFLICT" });
});

test("new finding responses use the unchanged artifact without replacing the prior Coder report", async () => {
  const f = fixture(), before = structuredClone(f.report);
  const tool = createRespondToReviewTool(f);
  const result = await tool.execute({ responses: [{ finding_id: "REV-2", position: "dispute", rationale: "Source already verified", files: [], evidence_refs: [f.artifact.artifact_id] }],
    review_commit_sha: f.artifact.commit_sha, artifact_id: f.artifact.artifact_id, source_revision: f.artifact.source_revision, idempotency_key: "RESPONSE-1" }, { agent_identity: { agent_id: "CODER" } });
  assert.equal(result.status, "submitted_for_review");
  assert.equal(f.history.coder_responses.length, 1);
  assert.deepEqual(f.history.coder_reports[0].report, before);
  assert.equal(f.history.findings[0].status, "open");
});
