// Verifies completion evidence covers every required plan check and diagnoses missing Node capabilities.
import assert from "node:assert/strict";
import test from "node:test";
import { completeNodeReportEvidence } from "../../src/tools/node-report-evidence.js";
import { assertCoderCoverage } from "../../src/modules/supervisor/completion-report-service.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";

const artifact = { artifact_id: "ARTIFACT-1", commit_sha: "commit", changed_paths: ["ui/nextjs/lib/example.js"], file_checksums: {}, commands: [{ kind: "test", exit_code: 0, argv: ["node", "--test", "ui/nextjs/tests/example.test.js"] }] };

// Produces one criterion report from Node receipts and the approved plan mapping.
function coverage(verificationPlan, commands = artifact.commands) {
  return completeNodeReportEvidence({ summary: "Preserved behavior" }, { acceptance_criteria: ["Behavior works"], verification_plan: verificationPlan }, { ...artifact, commands }).acceptance_coverage;
}

test("a passing test cannot mask required browser evidence on the same criterion", () => {
  const result = coverage([{ kind: "test", criterion_ids: ["AC-1"], test_path: "ui/nextjs/tests/example.test.js" }, { kind: "browser", criterion_ids: ["AC-1"], viewports: [1440], assertions: ["Behavior works"] }]);
  assert.equal(result[0].status, "evidence_pending");
  assert.deepEqual(result[0].missing_checks, [{ kind: "browser" }]);
  assert.throws(() => assertCoderCoverage(result), (error) => {
    assert.equal(error.code, "CODER_EVIDENCE_PENDING");
    assert.deepEqual(error.details, { criterion_ids: ["AC-1"], missing_checks: [{ criterion_id: "AC-1", kind: "browser" }] });
    assert.match(error.message, /AC-1:browser/);
    assert.match(error.message, /Run the required checks/);
    return true;
  });
});

test("governance does not waive a missing executable check on the same criterion", () => {
  const result = coverage([{ kind: "test", criterion_ids: ["AC-1"], test_path: "ui/nextjs/tests/missing.test.js" }, { kind: "governance", criterion_ids: ["AC-1"] }]);
  assert.equal(result[0].status, "evidence_pending");
  assert.deepEqual(result[0].missing_checks, [{ kind: "test", test_path: "ui/nextjs/tests/missing.test.js" }]);
});

test("every mapped test must pass before a compound criterion is verified", () => {
  const plan = [{ kind: "test", criterion_ids: ["AC-1"], test_path: "ui/nextjs/tests/example.test.js" }, { kind: "test", criterion_ids: ["AC-1"], test_path: "ui/nextjs/tests/other.test.js" }];
  assert.equal(coverage(plan)[0].status, "evidence_pending");
  const commands = [...artifact.commands, { kind: "test", exit_code: 0, argv: ["node", "--test", "ui/nextjs/tests/other.test.js"] }];
  const verified = coverage(plan, commands);
  assert.equal(verified[0].status, "verified");
  assert.doesNotThrow(() => assertCoderCoverage(verified));
});

test("governance-only and unmapped criteria retain distinct coverage states", () => {
  assert.equal(coverage([{ kind: "governance", criterion_ids: ["AC-1"] }])[0].status, "not_applicable");
  assert.equal(coverage([{ kind: "test", criterion_ids: ["AC-2"], test_path: "ui/nextjs/tests/example.test.js" }])[0].status, "evidence_pending");
});

test("human evidence is diagnosed as a missing capability rather than an automatic Coder retry", () => {
  assert.throws(() => assertCoderCoverage(coverage([{ kind: "human", criterion_ids: ["AC-1"] }])), (error) => {
    assert.deepEqual(error.details.unsupported_check_kinds, ["human"]);
    assert.match(error.message, /owner-approved plan revision/);
    return true;
  });
});

test("report_done cannot accept a Coder claim or passing build in place of approved browser evidence", async () => {
  let saved = false;
  const tool = createReportDoneTool({ verificationService: { assertPassedArtifact: async () => artifact }, reportService: { buildFinalReport: async () => ({}), saveReport: async () => { saved = true; }, writeReportFile: async () => {} } });
  await assert.rejects(tool.execute({ summary: "Done", acceptance_coverage: [{ criterion_id: "AC-1", status: "verified", command_kind: "test", test_path: "ui/nextjs/tests/example.test.js" }] }, { ticket: { id: "TICKET-1", acceptance_criteria: ["Behavior works"], verification_plan: [{ kind: "browser", criterion_ids: ["AC-1"], viewports: [1440], assertions: ["Behavior works"] }] } }), (error) => error.code === "CODER_EVIDENCE_PENDING" && error.details.missing_checks.some((check) => check.kind === "browser"));
  assert.equal(saved, false);
});
