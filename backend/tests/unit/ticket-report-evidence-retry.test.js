/** Exercises the complete partial-report retry contract with persisted review
 * drafts and immutable verification supplements. Coder requests may add one
 * missing check at a time without resending their explanation or earlier test
 * bindings, while Node still rejects absent, failed or mismatched evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket/ticket-review-findings.js";
import { createTicketReportChecks } from "../../src/modules/supervisor/ticket/ticket-report-checks.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";
import { buildCodexTicketPrompt, buildToolTicketPrompt } from "../../src/modules/supervisor/nodeforge-task-prompts.js";

// Both provider paths must request real receipt references and retained drafts
// rather than telling agents to repeat tests or reconstruct their whole report.
test("Claude and Codex receive the same missing-evidence retry instructions", () => {
  for (const build of [buildCodexTicketPrompt, buildToolTicketPrompt]) {
    const prompt = build({ id: "TICKET", implementation_type: ["backend"] }, null, ["backend/"], { discovery_budget: 8 });
    assert.match(prompt, /run only the named missing checks with run_check/);
    assert.match(prompt, /reference:"CHECK-\.\.\."/);
    assert.match(prompt, /restores saved draft fields and criterion test bindings/);
    assert.match(prompt, /use its recorded dependency snapshot/);
  }
});

/** Reproduces the two missing acceptance checks using real durable draft
 * storage and source-bound Node receipts, independently of a model provider. */
test("partial report retries retain test bindings and prior receipts through supplemental artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-report-evidence-retry-"));
  try {
    const paths = ["backend/tests/unit/one.test.js", "backend/tests/unit/two.test.js"];
    const base = { artifact_id: "ARTIFACT-BASE", task_id: "TICKET", status: "passed", commit_sha: "a".repeat(40), source_revision: "source", manifest_sha: "manifest", environment: { sha256: "e".repeat(64) },
      changed_paths: ["backend/src/example.js"], file_checksums: { "backend/src/example.js": "sha256:file" }, commands: [], planned_commands: [] };
    let context = { version: 1, verification_artifact_id: base.artifact_id, review_commit_sha: base.commit_sha, source_revision: base.source_revision, manifest_sha: base.manifest_sha };
    const artifacts = new Map([[base.artifact_id, base]]);
    const receipts = new Map(paths.map((path, index) => [`CHECK-${index + 1}`, { check_id: `CHECK-${index + 1}`, task_id: "TICKET", status: "passed", exit_code: 0,
      pre_commit: false, commit_sha: base.commit_sha, source_revision: base.source_revision, environment: base.environment, type: "test", command: `node --test ${path}`, output_sha256: `sha256:${"f".repeat(64)}` }]));
    const fileService = createFileService({ projectRoot: root });
    const reviews = () => createTicketReviewFindingsStore({ taskId: "TICKET", fileService, executionContexts: { load: async () => context } });
    const ticket = { id: "TICKET", acceptance_criteria: ["One behavior works", "Two behavior works"], verification_plan: paths.map((_, index) => ({ kind: "backend_tests", criterion_ids: [`AC-${index + 1}`] })) };
    const submitted = [];
    const tools = () => createReportDoneTool({ reviewFindings: reviews(),
      verificationService: { assertPassedArtifact: async () => artifacts.get(context.verification_artifact_id), prepareReportEvidence: createTicketReportChecks({
        taskId: "TICKET", loadContext: async () => ({ ...context }), assertIdentity: async () => {}, loadArtifact: async (id) => artifacts.get(id), loadCheck: async (id) => receipts.get(id),
        saveArtifact: async (artifact) => { artifacts.set(artifact.artifact_id, artifact); }, updateContext: async (version, changes) => { assert.equal(version, context.version); context = { ...context, ...changes, version: version + 1 }; }
      }).prepareReportEvidence },
      reportService: { buildFinalReport: async ({ status }) => ({ status }), saveReport: async (_, report) => submitted.push(report), writeReportFile: async () => {} }
    });
    const initial = { summary: "Implemented both behaviors", acceptance_coverage: paths.map((path, index) => ({ criterion_id: `AC-${index + 1}`, command_kind: "backend_tests", test_path: path })) };
    await assert.rejects(tools().execute(initial, { ticket }), { code: "CODER_EVIDENCE_PENDING" });
    const evidence = (index) => [{ type: "run_check", reference: `CHECK-${index}`, result: "Persisted passing focused check" }];
    await assert.rejects(tools().execute({ evidence: evidence(1), acceptance_coverage: [{ criterion_index: 0, status: "verified" }] }, { ticket }), (error) => {
      assert.equal(error.code, "CODER_EVIDENCE_PENDING");
      assert.deepEqual(error.details.criterion_ids, ["AC-2"]);
      return true;
    });
    assert.equal(submitted.length, 0);
    await tools().execute({ evidence: evidence(2) }, { ticket });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].status, "submitted_for_review");
    assert.equal(submitted[0].agent_report.summary, initial.summary);
    assert.deepEqual(submitted[0].criteria_check.map((entry) => [entry.status, entry.test_path]), paths.map((path) => ["verified", path]));
    assert.deepEqual(submitted[0].agent_report.evidence.filter((item) => item.type === "run_check").map((item) => item.reference), ["CHECK-1", "CHECK-2"]);
    const history = await reviews().load();
    assert.equal(history.coder_reports.length, 1);
    assert.equal(history.coder_report_drafts.at(-1).original_report.summary, initial.summary);
    assert.deepEqual(artifacts.get(context.verification_artifact_id).supplemental_checks, ["CHECK-1", "CHECK-2"]);
    await assert.rejects(tools().execute({ summary: "Changed completed report" }, { ticket }), { code: "CODER_REPORT_CONFLICT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
