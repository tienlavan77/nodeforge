// Verifies findings keep stable IDs and require revision-bound resolution evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";

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
    assert.equal((await first.load()).findings[0].resolved_revision, "source-2");
    await first.assertResolved();
    await first.recordReview({ verdict: "approved", findings: [], artifactId: artifact.artifact_id, commitSha: artifact.commit_sha });
  } finally { await rm(root, { recursive: true, force: true }); }
});
