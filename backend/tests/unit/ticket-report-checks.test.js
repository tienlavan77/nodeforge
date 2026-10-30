/** Reproduces report rejection after successful focused checks and verifies
 * supplemental acceptance evidence remains immutable and bound to its source. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket/ticket-verification-service.js";
import { persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { createTicketReportChecks } from "../../src/modules/supervisor/ticket/ticket-report-checks.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";
import { coversVerificationPolicy } from "../../src/modules/supervisor/ticket/ticket-verification-policy.js";

/** Models durable Node evidence without a provider, database or mutable project
 * checkout, allowing process restart and interrupted publication to be tested. */
function fixture() {
  const path = "backend/tests/unit/legacy.test.js";
  const digest = `sha256:${"a".repeat(64)}`;
  const commands = ["typecheck", "lint", "schema_validation", "backend_tests"].map((kind) => ({ kind,
    ...(kind === "backend_tests" ? { scope: "ticket", test_paths: ["backend/tests/unit/new.test.js"], criterion_ids: ["AC-1"] } : {}),
    argv: kind === "backend_tests" ? ["node", "--test", "backend/tests/unit/new.test.js"] : ["node", kind], exit_code: 0, output_sha256: digest }));
  const artifact = { artifact_id: "ARTIFACT-BASE", task_id: "TICKET", project_id: "PROJECT", status: "passed", policy_version: "ticket-verification-v8",
    commit_sha: "c".repeat(40), source_revision: "sha256:source", manifest_sha: "sha256:manifest", environment: { sha256: "e".repeat(64) },
    file_checksums: { "backend/src/new.js": "sha256:file" }, changed_paths: ["backend/src/new.js"],
    planned_commands: commands.map((command) => { const planned = { ...command }; delete planned.exit_code; delete planned.output_sha256; return planned; }), commands };
  const context = { version: 1, verification_artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision };
  const receipt = { check_id: "CHECK-ONE", task_id: "TICKET", pre_commit: false, commit_sha: artifact.commit_sha, source_revision: artifact.source_revision,
    environment: artifact.environment, status: "passed", type: "test", command: `node --test ${path}`, exit_code: 0, output_sha256: digest, stdout: "16 tests passed", stderr: "" };
  const checks = new Map([[receipt.check_id, receipt]]);
  const artifacts = new Map([[artifact.artifact_id, structuredClone(artifact)]]);
  const evidence = [{ type: "run_check", reference: receipt.check_id, result: "The agent's words are not trusted" }];
  const services = { taskId: "TICKET", loadContext: async () => structuredClone(context), loadCheck: async (id) => checks.get(id), loadArtifact: async (id) => artifacts.get(id),
    assertIdentity: async () => {}, saveArtifact: async (next) => {
      const previous = artifacts.get(next.artifact_id);
      if (previous) assert.deepEqual(previous, next);
      artifacts.set(next.artifact_id, structuredClone(next));
    }, updateContext: async (version, changes) => {
      assert.equal(context.version, version); Object.assign(context, changes); context.version++;
    } };
  return { path, artifact, context, receipt, evidence, checks, artifacts, services, create: () => createTicketReportChecks(services) };
}

// The reported incident must advance to review using Node's real checks, not Coder prose.
test("report_done joins the exact focused check to a pathless backend step and persists review evidence", async () => {
  const f = fixture(); const original = JSON.stringify(f.artifact);
  const ticket = { id: "TICKET", acceptance_criteria: ["New behavior works", "Legacy commands keep working"], verification_plan: [
    { kind: "test", test_path: "backend/tests/unit/new.test.js", criterion_ids: ["AC-1"] },
    { kind: "backend_tests", criterion_ids: ["AC-2"], notes: "Existing command and approval checks" }
  ] };
  let saved;
  const service = { assertPassedArtifact: async () => f.artifacts.get(f.context.verification_artifact_id), prepareReportEvidence: f.create().prepareReportEvidence };
  const tool = createReportDoneTool({ verificationService: service,
    reviewFindings: { recordCoderReportDraft: async ({ report }) => report, recordCoderReport: async () => {} },
    reportService: { buildFinalReport: async ({ status }) => ({ status }), saveReport: async (_id, report) => { saved = report; }, writeReportFile: async () => {} } });
  const input = { summary: "Implementation and legacy command checks passed", evidence: f.evidence,
    acceptance_coverage: [{ criterion_id: "AC-2", command_kind: "test", test_path: f.path, status: "verified" }] };
  await tool.execute(input, { ticket });
  assert.equal(saved.status, "submitted_for_review");
  assert.deepEqual(saved.criteria_check.map((entry) => entry.status), ["verified", "verified"]);
  assert.equal(saved.criteria_check[1].test_path, f.path);
  assert.notEqual(f.context.verification_artifact_id, f.artifact.artifact_id);
  const current = await service.assertPassedArtifact();
  assert.equal(coversVerificationPolicy(current, f.artifact.changed_paths, ticket.verification_plan), true);
  assert.equal(current.commands.at(-1).check_id, "CHECK-ONE");
  await f.create().assertReportChecks(current);
  const version = f.context.version;
  await tool.execute(input, { ticket });
  assert.equal(f.context.version, version); assert.equal(f.artifacts.size, 2);
  assert.equal(JSON.stringify(f.artifact), original);
});

// Untrusted report text cannot promote stale, different-ticket or pre-commit receipts.
test("forged or different-ticket receipts fail before any artifact or context is written", async () => {
  for (const changes of [{ task_id: "OTHER" }, { check_id: "CHECK-OTHER" }, { output_sha256: null }]) {
    const f = fixture(); Object.assign(f.receipt, changes);
    await assert.rejects(f.create().prepareReportEvidence({ artifact: f.artifact, evidence: f.evidence }), { code: "VERIFY_CHECK_IDENTITY_MISMATCH" });
    assert.equal(f.artifacts.size, 1); assert.equal(f.context.version, 1);
  }
});

// Historic evidence may remain in a report but cannot satisfy current acceptance.
test("pre-commit, stale source and different environments remain diagnostic evidence only", async () => {
  for (const changes of [{ pre_commit: true }, { commit_sha: "d".repeat(40) }, { source_revision: "other" },
    { environment: { sha256: "f".repeat(64) } }, { environment: null }]) {
    const f = fixture(); Object.assign(f.receipt, changes);
    assert.equal(await f.create().prepareReportEvidence({ artifact: f.artifact, evidence: f.evidence }), f.artifact);
    assert.equal(f.artifacts.size, 1); assert.equal(f.context.version, 1);
  }
});

// Failed or missing checks never become passing evidence through a report reference.
test("failed, missing and fabricated receipt references cannot establish coverage", async () => {
  const f = fixture(); f.receipt.exit_code = 1; f.receipt.status = "failed";
  assert.equal(await f.create().prepareReportEvidence({ artifact: f.artifact, evidence: f.evidence }), f.artifact);
  assert.equal(f.artifacts.size, 1);
  f.checks.clear();
  await assert.rejects(f.create().prepareReportEvidence({ artifact: f.artifact, evidence: f.evidence }), { code: "VERIFY_CHECK_IDENTITY_MISMATCH" });
  assert.equal(await f.create().prepareReportEvidence({ artifact: f.artifact, evidence: [{ type: "run_check", reference: "../../another-ticket.json" }] }), f.artifact);
});

// A crash after artifact publication must reuse the immutable bytes on retry.
test("interrupted publication and restart reuse the supplemental artifact idempotently", async () => {
  const f = fixture(); const update = f.services.updateContext;
  f.services.updateContext = async () => { throw new Error("interrupted"); };
  await assert.rejects(f.create().prepareReportEvidence({ artifact: f.artifact, evidence: f.evidence }), /interrupted/);
  assert.equal(f.artifacts.size, 2); assert.equal(f.context.version, 1);
  f.services.updateContext = update;
  const next = await f.create().prepareReportEvidence({ artifact: f.artifact, evidence: f.evidence });
  await f.create().assertReportChecks(next); assert.equal(f.artifacts.size, 2);
  const restored = f.create(); assert.equal(await restored.prepareReportEvidence({ artifact: next, evidence: f.evidence }), next);
  f.receipt.stdout = "altered output";
  await assert.rejects(restored.assertReportChecks(next), { code: "VERIFY_CHECK_IDENTITY_MISMATCH" });
});

// Supplemental tests cannot replace exact required tests or a real browser receipt.
test("supplemental passing tests do not waive a different planned test or browser check", async () => {
  for (const step of [{ kind: "test", test_path: "backend/tests/unit/required.test.js" }, { kind: "browser", viewports: [1440], assertions: ["Works"] }]) {
    const f = fixture(); let saved = false;
    const tool = createReportDoneTool({ verificationService: { assertPassedArtifact: async () => f.artifact, prepareReportEvidence: f.create().prepareReportEvidence },
      reportService: { buildFinalReport: async () => ({}), saveReport: async () => { saved = true; }, writeReportFile: async () => {} } });
    await assert.rejects(tool.execute({ summary: "Done", evidence: f.evidence, acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "test", test_path: f.path }] },
      { ticket: { id: "TICKET", acceptance_criteria: ["Works"], verification_plan: [{ ...step, criterion_ids: ["AC-1"] }] } }), { code: "CODER_EVIDENCE_PENDING" });
    assert.equal(saved, false);
  }
});

// The production service must reload a supplemented artifact under its full
// verification policy, not just pass through the helper used by report_done.
test("verification service persists and reloads supplemental receipts through File Service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-report-checks-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(); const files = createFileService({ projectRoot: root });
  const path = "backend/src/new.js", content = "// Supplies a committed verification fixture.\nexport const value = true;\n";
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const environment = await persistVerificationEnvironment(root, { files: [], manifest: [], sha256: createHash("sha256").update("[]").digest("hex") });
  Object.assign(f.artifact, { environment, base_sha: "b".repeat(40), file_checksums: { [path]: checksum } });
  f.receipt.environment = environment;
  Object.assign(f.context, { state: "verified", base_sha: f.artifact.base_sha, manifest_sha: f.artifact.manifest_sha, manifest_paths: [path], verification_plan: [] });
  const basePath = ".forge/runtime/ticket-verification/TICKET/artifacts/ARTIFACT-BASE.json";
  await files.atomicWrite({ path, content, replace: false });
  await files.atomicWrite({ path: basePath, content: JSON.stringify(f.artifact), replace: false });
  await files.atomicWrite({ path: ".forge/runtime/ticket-verification/TICKET/checks/CHECK-ONE.json", content: JSON.stringify(f.receipt), replace: false });
  const options = { taskId: "TICKET", projectId: "PROJECT", projectRoot: root, worktreeRoot: root, worktreeFileService: files, stateFileService: files,
    gitService: { getHead: async () => f.artifact.commit_sha, getCommitParent: async () => f.artifact.base_sha, getChangedFiles: async () => [path], status: async () => "" },
    ledger: { snapshot: async () => ({ entries: { [path]: { latest_sha: checksum } } }) },
    executionContexts: { load: f.services.loadContext, update: async (_task, version, changes) => f.services.updateContext(version, changes),
      manifestIdentity: () => ({ source_revision: f.context.source_revision, manifest_sha: f.context.manifest_sha, manifest_paths: [path] }) } };
  const service = createTicketVerificationService(options);
  const original = await files.readFile({ path: basePath });
  const artifact = await service.prepareReportEvidence({ artifact: await service.assertPassedArtifact(), evidence: f.evidence });
  assert.equal(artifact.commands.at(-1).check_id, "CHECK-ONE");
  const restarted = createTicketVerificationService(options);
  assert.deepEqual(await restarted.assertPassedArtifact(), artifact);
  assert.equal(await files.readFile({ path: basePath }), original);
  await restarted.prepareReportEvidence({ artifact, evidence: f.evidence });
  assert.equal(f.context.version, 2);
});
