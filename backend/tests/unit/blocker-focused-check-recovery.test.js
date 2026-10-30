// Prevents source-bound focused test failures from being mistaken for missing
// authorization while preserving denials, incomplete receipts and source identity.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { readBlockerVerificationEvidence } from "../../src/modules/supervisor/blocker/blocker-verification-evidence.js";
import { createBlockerFailureClassification, requiresBlockerAdmission, requiresEvidenceReconciliation } from "../../src/modules/supervisor/blocker/blocker-failure-classification.js";

// Models an original server-recorded blocked report and independently persisted
// failed check. Mutations let tests prove each identity boundary is enforced.
function fixture(taskId = "TICKET-A") {
  const context = { task_id: taskId, project_id: "PROJECT-A", source_revision: "SOURCE", manifest_sha: "MANIFEST", base_sha: "BASE", review_commit_sha: null };
  const job = { id: "JOB-" + taskId, reason_code: "ACCESS_REQUIRED", failure_at: "2026-10-26T08:47:00Z",
    request: { project_id: context.project_id, task_id: taskId, execution_context: { ...context } } };
  const evidence = { status: "captured", receipts: [{ tool: "report_done", error: { code: "CODER_BLOCKED" },
    arguments: { evidence: [{ type: "run_check", reference: "CHECK-FAILED", result: "failed" }] } }] };
  const check = { check_id: "CHECK-FAILED", task_id: taskId, source_revision: context.source_revision, commit_sha: null, pre_commit: true,
    type: "test", status: "failed", exit_code: 1, completed_at: "2026-10-26T08:46:00Z", receipt_sha256: "sha256:" + "a".repeat(64) };
  const verification = { status: "missing", checks: [check] };
  const workspace = { projectRoot: "/project", executionContexts: { load: async () => context } };
  const classify = createBlockerFailureClassification({ readFailureEvidence: async () => evidence, readVerificationEvidence: async () => verification });
  return { job, context, evidence, check, workspace, verification, classify };
}

// Multiple tickets use the same recovery rule without changing their original
// report label, awarding acceptance, or inventing an access authorization.
test("explicit failed check receipts allow technical recovery for any ticket", async () => {
  for (const taskId of ["TICKET-A", "TICKET-B"]) {
    const f = fixture(taskId);
    f.job.ticket_progress = { failure_classification: await f.classify(f.job, f.workspace) };
    assert.equal(f.job.ticket_progress.failure_classification.category, "technical_failure");
    assert.equal(f.job.ticket_progress.failure_classification.effective_reason_code, "VERIFY_COMMAND_FAILED");
    assert.deepEqual(f.job.ticket_progress.failure_classification.check_ids, ["CHECK-FAILED"]);
    assert.equal(requiresEvidenceReconciliation(f.job), false); assert.equal(requiresBlockerAdmission(f.job), false);
    assert.equal(f.job.reason_code, "ACCESS_REQUIRED"); assert.equal(f.check.status, "failed");
  }
});

// Narrative-only, future, historical and mismatched evidence cannot replace an
// original source-bound Node receipt or override a real authorization refusal.
test("missing evidence and genuine denials remain protected", async () => {
  for (const change of [
    f => { f.evidence.status = "partial"; }, f => { f.evidence.receipts[0].arguments = {}; },
    f => { f.check.source_revision = "OLD"; }, f => { f.context.manifest_sha = "CHANGED"; },
    f => { f.check.receipt_sha256 = undefined; }, f => { f.check.completed_at = "2026-10-26T09:00:00Z"; },
    f => { f.check.pre_commit = false; }, f => { f.check.exit_code = null; }, f => { f.check.status = "passed"; },
    f => { f.verification.checks = []; }, f => { f.job.execution_admission = { status: "awaiting_owner_review" }; },
    f => { f.evidence.receipts.push({ tool: "write_diff", error: { code: "APPROVAL_DENIED" } }); }
  ]) {
    const f = fixture(); change(f);
    const classified = await f.classify(f.job, f.workspace);
    assert.notEqual(classified.category, "technical_failure");
  }
});

// Grouped runtime storage must be enumerated through the layout resolver rather
// than silently reporting an existing receipt directory as missing.
test("grouped runtime receipts are discovered and independently classified", async t => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "nf-focused-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".forge/runtime/tickets/ticket-verification/TICKET-A/checks"), { recursive: true });
  await writeFile(join(root, ".forge/runtime/runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready" }));
  const files = createFileService({ projectRoot: root, role: "system_engineer" });
  const body = { ...f.check }; delete body.receipt_sha256;
  await files.atomicWrite({ path: ".forge/runtime/ticket-verification/TICKET-A/checks/CHECK-FAILED.json", content: JSON.stringify(body), replace: false });
  f.workspace.projectRoot = root;
  const evidence = await readBlockerVerificationEvidence({ job: f.job, workspace: f.workspace, context: f.context });
  assert.equal(evidence.checks[0].check_id, "CHECK-FAILED"); assert.equal(evidence.receipt_index.length, 1);
  const classify = createBlockerFailureClassification({ readFailureEvidence: async () => f.evidence });
  const result = await classify(f.job, f.workspace);
  assert.equal(result.category, "technical_failure"); assert.deepEqual(result.check_ids, ["CHECK-FAILED"]);
});
