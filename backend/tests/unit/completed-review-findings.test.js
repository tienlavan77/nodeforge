// Checks legacy review finding recovery against the real durable store without launching agents or changing ticket status.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket/ticket-review-findings.js";
import { recordAutomaticReviewFindings } from "../../src/modules/supervisor/review/automatic-review-findings.js";
import { restoreCompletedReviewFindings } from "../../src/modules/supervisor/review/completed-review-findings.js";

// Creates a completed, exact-revision review with missing durable findings using the production finding store.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-review-findings-"));
  const files = createFileService({ projectRoot: root });
  const artifact = { artifact_id: "ARTIFACT-ONE", commit_sha: "a".repeat(40), manifest_sha: "manifest", source_revision: "source", base_sha: "b".repeat(40), status: "passed" };
  const context = { task_id: "T", state: "terminal", source_revision: artifact.source_revision, review_commit_sha: artifact.commit_sha, manifest_sha: artifact.manifest_sha, base_sha: artifact.base_sha, verification_artifact_id: artifact.artifact_id };
  const findings = ["Missing session coverage", "Missing read access"].map((failure) => ({ severity: "major", acceptance_criterion: "AC-1", failure, evidence_refs: [artifact.artifact_id], minimum_change_scope: "Add focused verification.", files: [] }));
  const job = { task_id: "T", agent_id: "CODER", payload: { verification: artifact }, decision_identity: { ...context, review_commit_sha: artifact.commit_sha, artifact_id: artifact.artifact_id } };
  const prior = { task_id: "T", request_id: "REVIEW-ONE", reviewer_id: "REVIEWER", status: "completed", verdict: "request_changes", commit: artifact.commit_sha, source_revision: artifact.source_revision, verification: artifact, findings };
  const executionContexts = { load: async () => context };
  const store = createTicketReviewFindingsStore({ taskId: "T", fileService: files, executionContexts });
  const workspace = { executionContexts, reviewFindings: store };
  const logs = [];
  const options = { job, prior, workspace, projectLogger: (event) => logs.push(event) };
  return { artifact, context, prior, store, options, logs, close: () => rm(root, { recursive: true, force: true }) };
}

test("legacy completed review recovers every finding once with unchanged terminal context", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.context);
    const restored = await restoreCompletedReviewFindings(f.options);
    assert.deepEqual(restored.map((entry) => entry.finding_id), ["REV-1", "REV-2"]);
    assert(restored.every((entry) => entry.artifact_id === f.artifact.artifact_id && entry.review_commit_sha === f.artifact.commit_sha));
    const record = await f.store.load();
    assert.equal((await restoreCompletedReviewFindings(f.options)).length, 2);
    assert.deepEqual(await f.store.load(), record);
    assert.deepEqual(f.context, before); assert.equal(f.logs.length, 1);
  } finally { await f.close(); }
});

test("partial finding persistence restores only missing findings and preserves existing adjudications", async () => {
  const f = await fixture();
  try {
    await f.store.recordReview({ verdict: "request_changes", findings: [f.prior.findings[0]], artifactId: f.artifact.artifact_id, commitSha: f.artifact.commit_sha, reviewerId: "REVIEWER", sourceRevision: f.artifact.source_revision });
    await f.store.recordReview({ verdict: "request_changes", findings: [], adjudications: [{ finding_id: "REV-1", decision: "withdraw", reason: "Evidence corrected", evidence_refs: [f.artifact.artifact_id] }], artifactId: f.artifact.artifact_id, commitSha: f.artifact.commit_sha, reviewerId: "REVIEWER", sourceRevision: f.artifact.source_revision });
    const result = await restoreCompletedReviewFindings(f.options);
    assert.deepEqual(result.map((entry) => entry.finding_id), ["REV-2"]);
    assert.equal((await f.store.load()).findings.length, 2);
    assert.equal((await f.store.load()).adjudications.length, 1);
    assert.equal((await restoreCompletedReviewFindings(f.options)).length, 1);
  } finally { await f.close(); }
});

test("checkpoint source or reviewer conflicts cannot write findings or alter context", async () => {
  for (const mutation of [
    (f) => { f.prior.commit = "other"; },
    (f) => { f.prior.task_id = "OTHER"; },
    (f) => { f.prior.status = "failed"; },
    (f) => { f.prior.verification = { ...f.artifact, artifact_id: "ARTIFACT-OTHER" }; },
    (f) => { f.context.manifest_sha = "other"; },
    (f) => { f.prior.reviewer_id = "CODER"; }
  ]) {
    const f = await fixture();
    try {
      mutation(f);
      await assert.rejects(restoreCompletedReviewFindings(f.options), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });
      assert.equal((await f.store.load()).version, 0); assert.equal(f.logs.length, 0);
    } finally { await f.close(); }
  }
});

// Post-completion review must persist findings even when review is non-blocking, and reject source drift.
test("soft review records real durable findings before completion and rejects mismatched completed source", async () => {
  const f = await fixture();
  try {
    const job = { ...f.options.job, review_policy: { gate: "off" } };
    const payload = { ...f.prior, reviewer_id: "REVIEWER" };
    await recordAutomaticReviewFindings({ job, workspace: f.options.workspace, payload });
    assert.equal((await f.store.unresolved()).length, 2);
    const before = await f.store.load();
    f.context.source_revision = "changed";
    await assert.rejects(recordAutomaticReviewFindings({ job, workspace: f.options.workspace, payload }), { code: "REVIEW_EVIDENCE_MISMATCH" });
    assert.deepEqual(await f.store.load(), before);
  } finally { await f.close(); }
});
