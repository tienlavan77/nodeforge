// Regresses grouped backend verification reaching report_done without duplicate tests or fabricated acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket/ticket-verification-plan.js";
import { completeNodeReportEvidence } from "../../src/tools/reporting/node-report-evidence.js";
import { findPassingVerificationCommand } from "../../src/tools/reporting/verification-command-evidence.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";

const path = "backend/tests/integration/routing.test.js";
const step = { kind: "test", test_path: path, criterion_ids: ["AC-1", "AC-2"] };

test("receipt matching requires the exact test path and a successful compatible command", () => {
  const receipt = { kind: "backend_tests", exit_code: 0, argv: [process.execPath, "--test", path] };
  assert.equal(findPassingVerificationCommand(step, [receipt]), receipt);
  for (const command of [
    { ...receipt, exit_code: 1 }, { ...receipt, exit_code: null },
    { ...receipt, argv: ["node", "--test", `${path}.other`] },
    { ...receipt, argv: ["node", "--test", "backend/tests/unrelated.test.js"] },
    ...["lint", "build", "schema_validation", "typecheck"].map((kind) => ({ ...receipt, kind }))
  ]) assert.equal(findPassingVerificationCommand(step, [command]), undefined);
  assert.equal(findPassingVerificationCommand({ kind: "backend_tests" }, [{ ...receipt, kind: "test" }]), undefined);
});

test("compound coverage retains missing checks and ignores agent-provided passing claims", () => {
  const ticket = { acceptance_criteria: ["Behavior works"], verification_plan: [
    { ...step, criterion_ids: ["AC-1"] },
    { kind: "test", test_path: "backend/tests/second.test.js", criterion_ids: ["AC-1"] },
    { kind: "schema_validation", criterion_ids: ["AC-1"] }
  ] };
  const commands = [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", path] }];
  const result = completeNodeReportEvidence({ acceptance_coverage: [{ criterion_id: "AC-1", status: "verified" }] }, ticket, { commands });
  assert.equal(result.acceptance_coverage[0].status, "evidence_pending");
  assert.deepEqual(result.acceptance_coverage[0].missing_checks, [
    { kind: "test", test_path: "backend/tests/second.test.js" }, { kind: "schema_validation" }
  ]);
});

test("aggregate test evidence requires executed ticket paths and Node criterion bindings", () => {
  const aggregate = { kind: "backend_tests", criterion_ids: ["AC-1"] };
  const receipt = { kind: "backend_tests", scope: "ticket", criterion_ids: ["AC-1"],
    test_paths: [path], argv: ["node", "--test", path], exit_code: 0 };
  assert.equal(findPassingVerificationCommand(aggregate, [receipt]), receipt);
  for (const changes of [
    { exit_code: 1 }, { exit_code: null }, { scope: "regression" }, { scope: undefined },
    { criterion_ids: [] }, { criterion_ids: ["AC-2"] }, { test_paths: [] },
    { test_paths: ["backend/tests/unexecuted.test.js"] }, { argv: ["node", "scripts/run-backend-tests.mjs"] }
  ]) assert.equal(findPassingVerificationCommand(aggregate, [{ ...receipt, ...changes }]), undefined);
  assert.equal(findPassingVerificationCommand({ kind: "backend_tests" }, [receipt]), undefined);
});

test("real planner groups and runs the mapped test once and report_done accepts its immutable receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-command-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "backend/tests/integration"), { recursive: true });
  await mkdir(join(root, "backend/src"), { recursive: true });
  await writeFile(join(root, "backend/src/routing.js"), "// Supplies project routing.\nexport const routed = true;\n");
  await writeFile(join(root, path), "// Checks project routing and records actual test execution.\nrequire('node:test')('routing', () => { require('node:assert/strict').equal(1, 1); require('node:fs').writeFileSync('routing-executed', 'yes'); });\n");
  const ticket = { id: "T-ROUTING", acceptance_criteria: ["Selected project is routed", "Project state is isolated"],
    verification_plan: [step, { kind: "backend_tests", criterion_ids: ["AC-1", "AC-2"] }] };
  const plan = await buildTicketVerificationPlan(["backend/src/routing.js"], root, { verificationPlan: ticket.verification_plan });
  const tests = plan.filter((command) => ["test", "backend_tests"].includes(command.kind));
  assert.equal(tests.length, 1);
  assert.equal(tests[0].kind, "backend_tests");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const stdout = execFileSync(tests[0].argv[0], tests[0].argv.slice(1), { cwd: root, encoding: "utf8", env });
  assert.deepEqual(JSON.parse(stdout.trim()), { type: "summary", failed: 0, cancelled: 0 });
  assert.equal(await readFile(join(root, "routing-executed"), "utf8"), "yes");
  const artifact = { status: "passed", artifact_id: "ARTIFACT-GROUPED", commit_sha: "a".repeat(40),
    file_checksums: { "backend/src/routing.js": "sha256:source" }, commands: [{ ...tests[0], exit_code: 0, stdout_redacted: stdout }] };
  const original = JSON.stringify({ artifact, ticket });
  for (const withDraft of [false, true]) {
    let saved;
    let reads = 0;
    const tool = createReportDoneTool({ verificationService: { ensurePassedArtifact: async () => { reads++; return artifact; } },
      reportService: { buildFinalReport: async ({ status }) => ({ status }), saveReport: async (_task, report) => { saved = report; }, writeReportFile: async () => {} },
      ...(withDraft ? { reviewFindings: { recordCoderReportDraft: async ({ report }) => report, recordCoderReport: async () => {} } } : {}) });
    for (let retry = 0; retry < 2; retry++) {
      await tool.execute({ summary: "Routing verified" }, { ticket });
      assert.equal(saved.status, "submitted_for_review");
      assert.deepEqual(saved.criteria_check.map(({ status, command_kind, test_path }) => ({ status, command_kind, test_path })),
        ticket.acceptance_criteria.map(() => ({ status: "verified", command_kind: "backend_tests", test_path: path })));
    }
    assert.equal(reads, 2);
  }
  assert.equal(JSON.stringify({ artifact, ticket }), original);
});

test("legacy coverage hints use the actual grouped receipt kind and cannot claim an unrelated test", async () => {
  let saved;
  const artifact = { status: "passed", artifact_id: "ARTIFACT-LEGACY", file_checksums: {},
    commands: [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", path] }] };
  const tool = createReportDoneTool({ verificationService: { assertPassedArtifact: async () => artifact },
    reportService: { buildFinalReport: async () => ({}), saveReport: async (_task, report) => { saved = report; }, writeReportFile: async () => {} } });
  const ticket = { id: "T-LEGACY", acceptance_criteria: ["Project routing works"] };
  await tool.execute({ summary: "Done", acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "test", test_path: path }] }, { ticket });
  assert.equal(saved.criteria_check[0].command_kind, "backend_tests");
  await assert.rejects(tool.execute({ summary: "Done", acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "test", test_path: "backend/tests/unrelated.test.js" }] }, { ticket }), { code: "ACCEPTANCE_COVERAGE_MISSING" });
});
