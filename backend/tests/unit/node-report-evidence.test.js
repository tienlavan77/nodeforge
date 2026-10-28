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

// A generic backend step needs an explicit test binding, not any unrelated passing test.
test("a pathless backend plan uses the supplied exact test path without treating the hint as proof", () => {
  const ticket = { acceptance_criteria: ["Behavior works"], verification_plan: [{ kind: "backend_tests", criterion_ids: ["AC-1"] }] };
  const commands = [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", "backend/tests/unit/legacy.test.js"] }];
  const input = { acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "backend_tests", test_path: "backend/tests/unit/legacy.test.js" }] };
  assert.equal(completeNodeReportEvidence({}, ticket, { commands }).acceptance_coverage[0].status, "evidence_pending");
  assert.equal(completeNodeReportEvidence(input, ticket, { commands }).acceptance_coverage[0].status, "verified");
  const pending = completeNodeReportEvidence(input, ticket, { commands: [] });
  assert.equal(pending.acceptance_coverage[0].status, "evidence_pending");
  assert.equal(pending.acceptance_coverage[0].test_path, input.acceptance_coverage[0].test_path);
  assert.equal(completeNodeReportEvidence(pending, ticket, { commands }).acceptance_coverage[0].status, "verified");
  const legacy = { acceptance_coverage: [{ ...pending.acceptance_coverage[0], test_path: null }] };
  assert.equal(completeNodeReportEvidence(legacy, ticket, { commands }).acceptance_coverage[0].status, "verified");
});

test("human evidence is diagnosed as a missing capability rather than an automatic Coder retry", () => {
  assert.throws(() => assertCoderCoverage(coverage([{ kind: "human", criterion_ids: ["AC-1"] }])), (error) => {
    assert.deepEqual(error.details.unsupported_check_kinds, ["human"]);
    assert.match(error.message, /owner-approved plan revision/);
    return true;
  });
});

test("aggregate backend criteria reuse their own scoped receipts while retaining missing exact tests", () => {
  const paths = ["backend/tests/unit/one.test.js", "backend/tests/unit/two.test.js"];
  const ticket = { acceptance_criteria: ["One behavior works", "Two behavior works"], verification_plan: [
    ...paths.map((test_path, index) => ({ kind: "test", test_path, criterion_ids: [`AC-${index + 1}`] })),
    { kind: "backend_tests", criterion_ids: ["AC-1", "AC-2"] }
  ] };
  const commands = paths.map((path, index) => ({ kind: "backend_tests", scope: "ticket", criterion_ids: [`AC-${index + 1}`],
    test_paths: [path], argv: ["node", "--test", path], exit_code: 0 }));
  const result = completeNodeReportEvidence({}, ticket, { commands }).acceptance_coverage;
  assert.deepEqual(result.map((entry) => entry.status), ["verified", "verified"]);
  assert.doesNotThrow(() => assertCoderCoverage(result));
  const pending = completeNodeReportEvidence({}, ticket, { commands: commands.slice(0, 1) }).acceptance_coverage;
  assert.equal(pending[0].status, "verified");
  assert.equal(pending[1].status, "evidence_pending");
  const mismatched = [{ ...commands[0], test_paths: [paths[0], paths[1]], argv: ["node", "--test", ...paths] }];
  assert.equal(completeNodeReportEvidence({}, ticket, { commands: mismatched }).acceptance_coverage[1].status, "evidence_pending");
  const missingPath = { ...ticket, verification_plan: [...ticket.verification_plan,
    { kind: "test", test_path: "backend/tests/unit/missing.test.js", criterion_ids: ["AC-1"] }] };
  assert.deepEqual(completeNodeReportEvidence({}, missingPath, { commands }).acceptance_coverage[0].missing_checks,
    [{ kind: "test", test_path: "backend/tests/unit/missing.test.js" }]);
});

test("report_done cannot accept a Coder claim or passing build in place of approved browser evidence", async () => {
  let saved = false;
  const tool = createReportDoneTool({ verificationService: { assertPassedArtifact: async () => artifact }, reportService: { buildFinalReport: async () => ({}), saveReport: async () => { saved = true; }, writeReportFile: async () => {} } });
  await assert.rejects(tool.execute({ summary: "Done", acceptance_coverage: [{ criterion_id: "AC-1", status: "verified", command_kind: "test", test_path: "ui/nextjs/tests/example.test.js" }] }, { ticket: { id: "TICKET-1", acceptance_criteria: ["Behavior works"], verification_plan: [{ kind: "browser", criterion_ids: ["AC-1"], viewports: [1440], assertions: ["Behavior works"] }] } }), (error) => error.code === "CODER_EVIDENCE_PENDING" && error.details.missing_checks.some((check) => check.kind === "browser"));
  assert.equal(saved, false);
});
