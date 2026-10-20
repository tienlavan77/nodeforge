// Verifies findings keep stable IDs and require revision-bound resolution evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";

test("Reviewer refinement preserves the durable finding ID and prior evidence instead of creating duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-review-refinement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { verification_artifact_id: "ARTIFACT-NEW", review_commit_sha: "a".repeat(40), source_revision: "source" };
  const files = createFileService({ projectRoot: root });
  const store = createTicketReviewFindingsStore({ taskId: "TICKET-1", fileService: files, executionContexts: { load: async () => context } });
  const binding = { artifactId: context.verification_artifact_id, commitSha: context.review_commit_sha, reviewerId: "REVIEWER" };
  await store.recordReview({ ...binding, verdict: "request_changes", findings: ["Historical read restriction"] });
  const refinement = { finding_id: "REV-1", failure: "Access is repaired but routing evidence is incomplete", acceptance_criterion: "Routing isolation",
    evidence_refs: ["backend/router.js:10"], minimum_change_scope: "Add the missing transport witness" };
  const decision = { finding_id: "REV-1", decision: "refine", reason: "Current source is readable", evidence_refs: ["backend/router.js:10"] };
  for (let retry = 0; retry < 2; retry++) await store.recordReview({ ...binding, verdict: "request_changes", findings: [refinement], adjudications: [decision] });
  const record = await store.load();
  assert.equal(record.findings.length, 1);
  assert.equal(record.next_id, 2);
  assert.equal(record.findings[0].finding_id, "REV-1");
  assert.equal(record.findings[0].history.length, 1);
  assert.equal(record.findings[0].history[0].message, "Historical read restriction");
  assert.equal(record.findings[0].finding.failure, refinement.failure);
  assert.equal((await store.unresolved()).length, 1);
  await assert.rejects(store.recordReview({ ...binding, verdict: "request_changes", findings: [{ ...refinement, finding_id: "REV-99" }] }), { code: "REVIEW_FINDINGS_INVALID" });
  await assert.rejects(store.recordReview({ ...binding, verdict: "request_changes", findings: [{ ...refinement, finding_id: "TICKET-R1" }] }), { code: "REVIEW_FINDINGS_INVALID" });
  await store.recordReview({ ...binding, verdict: "approved", findings: [], adjudications: [{ ...decision, decision: "withdraw" }] });
  await assert.rejects(store.recordReview({ ...binding, verdict: "request_changes", findings: [refinement] }), { code: "REVIEW_FINDINGS_INVALID" });
});

// Preserves a repeated finding until a newer verified commit resolves its ID.
test("finding resolution persists across restart and blocks premature approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-findings-"));
  try {
    const context = { verification_artifact_id: "ARTIFACT-1", review_commit_sha: "a".repeat(40), source_revision: "source-1" };
    const open = () => createTicketReviewFindingsStore({ taskId: "TICKET-1", fileService: createFileService({ projectRoot: root }), executionContexts: { load: async () => context } });
    const first = open();
    const recorded = await first.recordReview({ verdict: "request_changes", findings: ["Handle empty input"], artifactId: "ARTIFACT-1", commitSha: context.review_commit_sha });
    assert.equal(recorded.findings[0].finding_id, "REV-1");
    await first.recordReview({ verdict: "request_changes", findings: ["Handle empty input"], artifactId: "ARTIFACT-1", commitSha: context.review_commit_sha });
    assert.equal((await open().load()).findings.length, 1);
    await assert.rejects(first.assertResolved(), { code: "REVIEW_FINDINGS_UNRESOLVED" });
    await assert.rejects(first.recordResolutions([{ finding_id: "REV-1", status: "fixed", changed_paths: ["backend/a.js"] }], { artifact_id: "ARTIFACT-1", commit_sha: context.review_commit_sha, source_revision: context.source_revision, file_checksums: { "backend/a.js": "sha256:a" } }), { code: "FINDING_RESOLUTION_STALE" });
    context.verification_artifact_id = "ARTIFACT-2";
    context.review_commit_sha = "b".repeat(40);
    context.source_revision = "source-2";
    const artifact = { artifact_id: "ARTIFACT-2", commit_sha: context.review_commit_sha, source_revision: context.source_revision, file_checksums: { "backend/a.js": "sha256:b" } };
    await open().recordResolutions([{ finding_id: "REV-1", status: "fixed", changed_paths: ["backend/a.js"] }], artifact);
    const afterClaim = await first.load();
    assert.equal(afterClaim.findings[0].status, "open");
    assert.equal(afterClaim.coder_claims.at(-1).source_revision, "source-2");
    await assert.rejects(first.assertResolved(), { code: "REVIEW_FINDINGS_UNRESOLVED" });
    await first.recordReview({ verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed", reason: "Reviewer verified the newer artifact.", evidence_refs: [artifact.artifact_id] }], reviewerId: "REVIEWER-1", sourceRevision: "source-2", artifactId: artifact.artifact_id, commitSha: artifact.commit_sha });
    await first.assertResolved();
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Keeps a Coder dispute blocking until an independent Reviewer adjudicates it.
test("coder response is durable, idempotent, and cannot close a finding", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-dispute-"));
  try {
    const commit = "c".repeat(40);
    const context = { verification_artifact_id: "ARTIFACT-D", review_commit_sha: commit, source_revision: "source-d", manifest_sha: "manifest-d" };
    const files = createFileService({ projectRoot: root });
    const store = createTicketReviewFindingsStore({ taskId: "T-DISPUTE", fileService: files, executionContexts: { load: async () => context } });
    await store.recordReview({ verdict: "request_changes", findings: ["The unchanged file needs evidence."], artifactId: "ARTIFACT-D", commitSha: commit });
    const artifact = { artifact_id: "ARTIFACT-D", status: "passed", commit_sha: commit, source_revision: "source-d", manifest_sha: "manifest-d", file_checksums: { "backend/a.js": "sha256:a" } };
    const response = { finding_id: "REV-1", position: "dispute", rationale: "The acceptance criterion is covered by the unchanged committed file.", files: ["backend/a.js"], evidence_refs: ["ARTIFACT-D"] };
    await store.recordResponse({ responses: [response], artifact, actor: "CODER-1", idempotencyKey: "RESP-1" });
    await store.recordResponse({ responses: [response], artifact, actor: "CODER-1", idempotencyKey: "RESP-1" });
    assert.equal((await store.load()).coder_responses.length, 1);
    await assert.rejects(store.assertResolved(), { code: "REVIEW_FINDINGS_UNRESOLVED" });
    await store.recordReview({ verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "withdraw", reason: "Reviewer verified the unchanged-file evidence.", evidence_refs: ["ARTIFACT-D"] }], reviewerId: "REVIEWER-1", sourceRevision: "source-d", artifactId: "ARTIFACT-D", commitSha: commit });
    await store.assertResolved();
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Requires a fresh Reviewer adjudication for every new Coder response and concrete scope for multi-file findings.
test("new response cannot reuse an older adjudication and multi-file findings need per-file evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-dispute-revision-"));
  try {
    const commit = "e".repeat(40);
    const context = { verification_artifact_id: "ARTIFACT-E", review_commit_sha: commit, source_revision: "source-e", manifest_sha: "manifest-e" };
    const files = createFileService({ projectRoot: root });
    const store = createTicketReviewFindingsStore({ taskId: "T-DISPUTE-REV", fileService: files, executionContexts: { load: async () => context } });
    await assert.rejects(store.recordReview({ verdict: "request_changes", findings: [{ acceptance_criterion: "A", failure: "Two files need changes", evidence_refs: ["ARTIFACT-E"], minimum_change_scope: "Change both files", files: ["backend/a.js", "backend/b.js"] }], artifactId: "ARTIFACT-E", commitSha: commit }), { code: "REVIEW_FINDINGS_INVALID" });
    await store.recordReview({ verdict: "request_changes", findings: [{ acceptance_criterion: "A", failure: "One file needs evidence", evidence_refs: ["ARTIFACT-E"], minimum_change_scope: "Review one file", files: ["backend/a.js"] }], artifactId: "ARTIFACT-E", commitSha: commit });
    const artifact = { artifact_id: "ARTIFACT-E", status: "passed", commit_sha: commit, source_revision: "source-e", manifest_sha: "manifest-e", file_checksums: { "backend/a.js": "sha256:a" } };
    await store.recordResponse({ responses: [{ finding_id: "REV-1", position: "dispute", rationale: "Evidence is already present.", files: ["backend/a.js"], evidence_refs: ["ARTIFACT-E"] }], artifact, actor: "CODER-1", idempotencyKey: "RESP-E-1" });
    await store.recordReview({ verdict: "request_changes", findings: [], adjudications: [{ finding_id: "REV-1", decision: "retain", reason: "Need one more source check.", evidence_refs: ["ARTIFACT-E"] }], reviewerId: "REVIEWER-1", sourceRevision: "source-e", artifactId: "ARTIFACT-E", commitSha: commit });
    await store.recordResponse({ responses: [{ finding_id: "REV-1", position: "accept", rationale: "I accept the requested check.", files: [], evidence_refs: ["ARTIFACT-E"] }], artifact, actor: "CODER-1", idempotencyKey: "RESP-E-2" });
    await assert.rejects(store.recordReview({ verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "withdraw", reason: "Old adjudication is not a decision on the new response.", evidence_refs: ["ARTIFACT-E"], response_id: "RESP-E-1" }], reviewerId: "REVIEWER-1", sourceRevision: "source-e", artifactId: "ARTIFACT-E", commitSha: commit }), { code: "REVIEW_ADJUDICATION_MISSING" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
