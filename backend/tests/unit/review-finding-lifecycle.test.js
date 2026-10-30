// Verifies independent Reviewer authority to close and reopen findings with durable evidence and stable identities.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket/ticket-review-findings.js";
import { parseReviewVerdict } from "../../src/modules/supervisor/review/review-verdict-contract.js";
import { requestReviewVerdict } from "../../src/modules/supervisor/review/review-verdict-request.js";

const finding = { acceptance_criterion: "AC-1 isolation", failure: "A linked directory redirects storage", minimum_change_scope: "Reject redirected runtime roots", evidence_refs: ["backend/storage.js:10"] };

// Creates a real durable finding store with a verified revision and a separate Reviewer identity.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-finding-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { review_commit_sha: "a".repeat(40), verification_artifact_id: "ARTIFACT-1", source_revision: "SOURCE-1", manifest_sha: "MANIFEST" };
  const binding = { artifactId: context.verification_artifact_id, commitSha: context.review_commit_sha, sourceRevision: context.source_revision, reviewerId: "REVIEWER" };
  const open = () => createTicketReviewFindingsStore({ taskId: "T", fileService: createFileService({ projectRoot: root }), executionContexts: { load: async () => context } });
  const store = open();
  await store.recordReview({ ...binding, verdict: "request_changes", findings: [finding] });
  const decision = (kind) => ({ finding_id: "REV-1", decision: kind, reason: "Current source and test evidence justify this decision", evidence_refs: ["backend/storage.js:10", "ARTIFACT-1"] });
  return { store, open, context, binding, decision };
}

for (const closed of ["fixed", "withdraw", "not_applicable"]) {
  for (const reopening of ["reopen", "refine", "retain"]) {
    test(`${closed} -> ${reopening} -> fixed keeps one ID, preserves history and survives restart`, async (t) => {
      const f = await fixture(t);
      await f.store.recordReview({ ...f.binding, verdict: "approved", findings: [], adjudications: [f.decision(closed)] });
      await f.open().assertResolved();
      const reopened = { ...f.binding, verdict: "request_changes", findings: [{ ...finding, finding_id: "REV-1", failure: "Existing linked runtime root remains unprotected" }], adjudications: [f.decision(reopening)] };
      const before = await f.store.load();
      await f.store.validateReview(reopened);
      assert.deepEqual(await f.store.load(), before, "validation must not publish reopening");
      await f.store.recordReview(reopened);
      await f.store.recordReview(reopened);
      const record = await f.open().load();
      assert.equal(record.findings.length, 1); assert.equal(record.next_id, 2);
      assert.equal(record.findings[0].status, "open");
      assert.equal(record.findings[0].history[0].status, closed);
      assert.deepEqual(record.adjudications.map((item) => item.decision), [closed, reopening]);
      assert.equal(record.adjudications[1].reviewer_id, "REVIEWER");
      assert.equal(record.adjudications[1].previous_status, closed);
      assert.equal((await f.open().unresolved())[0].finding_id, "REV-1");
      await assert.rejects(f.open().assertResolved(), { code: "REVIEW_FINDINGS_UNRESOLVED" });
      await assert.rejects(f.store.recordReview({ ...f.binding, verdict: "approved", findings: [] }), { code: "REVIEW_FINDINGS_UNRESOLVED" });
      await f.store.recordReview({ ...f.binding, verdict: "approved", findings: [], adjudications: [f.decision("fixed")] });
      await f.open().assertResolved();
      assert.deepEqual((await f.store.load()).adjudications.map((item) => item.decision), [closed, reopening, "fixed"]);
    });
  }
}

test("adjudication alone can reopen unchanged guidance and Coder claims still cannot close it", async (t) => {
  const f = await fixture(t);
  await f.store.recordReview({ ...f.binding, verdict: "approved", findings: [], adjudications: [f.decision("fixed")] });
  const value = { verdict: "request_changes", findings: [], adjudications: [f.decision("reopen")] };
  assert.deepEqual(parseReviewVerdict(JSON.stringify(value), { findingIds: ["REV-1"] }), value);
  await f.store.recordReview({ ...f.binding, ...value });
  assert.equal((await f.open().unresolved()).length, 1);
  const artifact = { status: "passed", artifact_id: f.binding.artifactId, commit_sha: f.binding.commitSha, source_revision: f.context.source_revision, manifest_sha: "MANIFEST", file_checksums: {} };
  await f.store.recordResponse({ actor: "CODER", idempotencyKey: "response", artifact, responses: [{ finding_id: "REV-1", position: "dispute", rationale: "Existing evidence establishes isolation", files: [], evidence_refs: [artifact.artifact_id] }] });
  await f.store.recordResolutions([{ finding_id: "REV-1", status: "not_applicable", changed_paths: [], evidence_refs: [artifact.artifact_id] }], artifact);
  await assert.rejects(f.store.assertResolved(), { code: "REVIEW_FINDINGS_UNRESOLVED" });
});

test("missing evidence, wrong reviewer binding, duplicates and contradictory decisions never partially persist", async (t) => {
  const f = await fixture(t);
  await f.store.recordReview({ ...f.binding, verdict: "approved", findings: [], adjudications: [f.decision("fixed")] });
  const proposal = { ...f.binding, verdict: "request_changes", findings: [{ ...finding, finding_id: "REV-1" }], adjudications: [f.decision("reopen")] };
  const before = await f.store.load();
  for (const invalid of [
    { ...proposal, adjudications: [] }, { ...proposal, reviewerId: null },
    { ...proposal, adjudications: [{ ...f.decision("reopen"), reason: "" }] },
    { ...proposal, adjudications: [{ ...f.decision("reopen"), evidence_refs: [" "] }] },
    { ...proposal, adjudications: [f.decision("reopen"), f.decision("fixed")] },
    { ...proposal, commitSha: "stale" },
    { ...proposal, verdict: "approved", findings: [] }
  ]) {
    await assert.rejects(f.store.recordReview(invalid));
    assert.deepEqual(await f.store.load(), before);
  }
});

test("same review atomically reopens an older finding and closes a newly repaired finding", async (t) => {
  const f = await fixture(t);
  await f.store.recordReview({ ...f.binding, verdict: "approved", findings: [], adjudications: [f.decision("fixed")] });
  await f.store.recordReview({ ...f.binding, verdict: "request_changes", findings: [{ ...finding, failure: "Session storage is unprotected" }] });
  const review = { ...f.binding, verdict: "request_changes", findings: [{ ...finding, finding_id: "REV-1", failure: "Nested runtime roots remain unprotected" }],
    adjudications: [f.decision("refine"), { ...f.decision("fixed"), finding_id: "REV-2" }] };
  await f.store.recordReview(review);
  assert.deepEqual((await f.open().unresolved()).map((item) => item.finding_id), ["REV-1"]);
  assert.deepEqual((await f.store.load()).findings.map((item) => item.status), ["open", "fixed"]);
});

test("durable-state validation is returned to the same Reviewer before accepting the corrected verdict", async (t) => {
  const f = await fixture(t);
  await f.store.recordReview({ ...f.binding, verdict: "approved", findings: [], adjudications: [f.decision("fixed")] });
  const before = await f.store.load();
  const invalid = { verdict: "request_changes", findings: [{ ...finding, finding_id: "REV-1" }], adjudications: [] };
  const valid = { ...invalid, adjudications: [f.decision("reopen")] };
  const requests = [], attempts = [];
  const result = await requestReviewVerdict({ prompt: "Review current revision", exchange: before, parseOptions: { findingIds: ["REV-1"] },
    revalidate: async () => {}, validate: (value) => f.store.validateReview({ ...f.binding, ...value }), onAttempt: async (attempt) => attempts.push(attempt),
    execute: async (prompt, correction) => { requests.push({ prompt, correction }); return { text: JSON.stringify(requests.length === 1 ? invalid : valid) }; } });
  assert.equal(requests.length, 2); assert.equal(requests[1].correction, true);
  assert.match(requests[1].prompt, /Reopening an existing finding/);
  assert.equal(attempts[0].error.code, "REVIEW_FINDINGS_INVALID");
  assert.deepEqual(await f.store.load(), before);
  await f.store.recordReview({ ...f.binding, ...result });
  assert.equal((await f.store.unresolved()).length, 1);
});
