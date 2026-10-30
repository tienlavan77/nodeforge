/** Regresses report completion against approved multi-check acceptance mappings.
 * Node must accept its own proven coverage in any language, retain each receipt,
 * and keep incomplete evidence as a recoverable draft on the same artifact. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket/ticket-review-findings.js";

const testPath = "backend/tests/integration/operation-contract.test.js";
const schemaStep = { kind: "schema_validation", criterion_ids: ["AC-1"] };
const testStep = { kind: "test", criterion_ids: ["AC-1"], test_path: testPath };
const artifact = {
  artifact_id: "ARTIFACT-PLAN-COVERAGE", status: "passed", commit_sha: "a".repeat(40),
  source_revision: "source", manifest_sha: "manifest", changed_paths: ["backend/src/operation.js"],
  file_checksums: { "backend/src/operation.js": "source-checksum" },
  commands: [
    { kind: "schema_validation", exit_code: 0, argv: ["node", "scripts/validate-schemas.mjs"], output_sha256: "1".repeat(64) },
    { kind: "backend_tests", exit_code: 0, argv: ["node", "--test", testPath], output_sha256: "2".repeat(64) }
  ]
};

/** Captures report publication while keeping immutable verification fixtures
 * separate from the optional durable Coder explanation store. */
function reportHarness(receipt = artifact, reviewFindings) {
  const saved = [];
  const tool = createReportDoneTool({
    verificationService: { assertPassedArtifact: async () => receipt }, reviewFindings,
    reportService: { buildFinalReport: async ({ status }) => ({ status }),
      saveReport: async (_id, report) => { saved.push(report); }, writeReportFile: async () => {} }
  });
  return { tool, saved };
}

for (const criterion of [
  "Contract mới có schema riêng. Transition không hợp lệ hoặc revision cũ bị từ chối.",
  "The operation contract rejects invalid transitions and stale revisions."
]) {
  for (const steps of [[schemaStep, testStep], [testStep, schemaStep]]) {
    test(`report_done accepts compound coverage: ${criterion} (${steps[0].kind} first)`, async () => {
      const ticket = { id: "T-PLAN-COVERAGE", acceptance_criteria: [criterion], verification_plan: steps };
      const original = structuredClone({ ticket, artifact });
      const { tool, saved } = reportHarness();
      for (const commandKind of ["schema_validation", "test"]) {
        await tool.execute({ summary: "Contract implemented", acceptance_coverage: [
          { criterion_id: "AC-1", command_kind: commandKind, ...(commandKind === "test" ? { test_path: testPath } : {}) }
        ] }, { ticket });
        const report = saved.at(-1);
        assert.equal(report.status, "submitted_for_review");
        const coverage = report.agent_report.acceptance_coverage[0];
        assert.equal(coverage.status, "verified");
        assert.equal(coverage.command_kind, "backend_tests");
        assert.equal(coverage.test_path, testPath);
        assert.deepEqual(coverage.verified_checks, steps.map((step) => ({
          kind: step.kind, command_kind: step.kind === "test" ? "backend_tests" : step.kind,
          ...(step.test_path ? { test_path: step.test_path } : {}),
          output_sha256: step.kind === "test" ? "2".repeat(64) : "1".repeat(64)
        })));
        assert.deepEqual(report.criteria_check[0].verified_checks, coverage.verified_checks);
      }
      assert.deepEqual({ ticket, artifact }, original);
    });
  }
}

test("approved command-only coverage is language independent", async () => {
  const ticket = { id: "T-SCHEMA", acceptance_criteria: ["Cấu trúc dữ liệu tuân thủ hợp đồng đã duyệt"], verification_plan: [schemaStep] };
  const { tool, saved } = reportHarness();
  await tool.execute({ summary: "Validated" }, { ticket });
  assert.equal(saved[0].criteria_check[0].node_verified, true);
  assert.equal(saved[0].criteria_check[0].command_kind, "schema_validation");
});

for (const missing of ["schema_validation", "test"]) {
  for (const failure of ["absent", "failed", "unrelated"]) {
    if (failure === "unrelated" && missing !== "test") continue;
    test(`compound completion rejects ${failure} ${missing} receipt despite Coder claims`, async () => {
      const rejectedKind = missing === "test" ? "backend_tests" : missing;
      const commands = artifact.commands.flatMap((command) => command.kind !== rejectedKind ? [command]
        : failure === "absent" ? [] : [{ ...command, ...(failure === "failed" ? { exit_code: 1 }
          : { argv: ["node", "--test", `${testPath}.other`] }) }]);
      const { tool, saved } = reportHarness({ ...artifact, commands });
      await assert.rejects(tool.execute({ summary: "Claimed success", acceptance_coverage: [
        { criterion_id: "AC-1", status: "verified", command_kind: "test", test_path: testPath,
          verified_checks: [{ kind: missing, command_kind: rejectedKind }] }
      ] }, { ticket: { id: "T-MISSING", acceptance_criteria: ["Contract behavior works"], verification_plan: [schemaStep, testStep] } }), (error) => {
        assert.equal(error.code, "CODER_EVIDENCE_PENDING");
        assert.deepEqual(error.details.missing_checks, [{ criterion_id: "AC-1", kind: missing, ...(missing === "test" ? { test_path: testPath } : {}) }]);
        return true;
      });
      assert.equal(saved.length, 0);
    });
  }
}

for (const legacyDraft of [false, true]) test(`compound drafts recover across restart (${legacyDraft ? "old schema representative" : "supplemental artifact"})`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-plan-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ticket = { id: "T-PLAN-RECOVERY", acceptance_criteria: ["Contract mới có schema và kiểm tra transition"], verification_plan: [schemaStep, testStep] };
  let current = legacyDraft ? artifact : { ...artifact, artifact_id: "ARTIFACT-BASE", commands: artifact.commands.slice(0, 1) };
  const store = () => createTicketReviewFindingsStore({ taskId: ticket.id, fileService: createFileService({ projectRoot: root }),
    executionContexts: { load: async () => ({ verification_artifact_id: current.artifact_id, review_commit_sha: current.commit_sha,
      source_revision: current.source_revision, manifest_sha: current.manifest_sha }) } });
  if (legacyDraft) {
    await store().recordCoderReportDraft({ report: { summary: "Contract implemented", acceptance_coverage: [
      { criterion_id: "AC-1", status: "verified", command_kind: "schema_validation" }
    ] }, artifact: current });
  } else {
    const pending = reportHarness(current, store());
    await assert.rejects(pending.tool.execute({ summary: "Contract implemented" }, { ticket }), { code: "CODER_EVIDENCE_PENDING" });
    assert.deepEqual((await store().load()).coder_report_drafts[0].report.acceptance_coverage[0].missing_checks, [{ kind: "test", test_path: testPath }]);
    current = { ...artifact, supplemental_base_artifact_id: current.artifact_id };
  }
  assert.equal((await store().load()).coder_reports.length, 0);
  const recovered = reportHarness(current, store());
  await recovered.tool.execute({}, { ticket });
  const completed = (await store().load()).coder_reports;
  assert.equal(completed.length, 1);
  assert.equal(completed[0].report.summary, "Contract implemented");
  assert.equal(completed[0].report.acceptance_coverage[0].verified_checks.length, 2);
  await reportHarness(current, store()).tool.execute({}, { ticket });
  assert.deepEqual((await store().load()).coder_reports, completed);
  assert.equal(recovered.saved[0].status, "submitted_for_review");
});
