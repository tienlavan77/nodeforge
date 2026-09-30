// Verifies Reviewer source and approval identity are bound to one committed ticket artifact.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { assertTicketReviewEvidence } from "../../src/modules/supervisor/ticket-review-evidence.js";

// Detects mismatched commit, manifest, content, and dirty worktree before review.
test("review evidence requires the verified committed source", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-review-identity-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    const path = "backend/src/feature.js";
    const source = "export const feature = true;\n";
    await fileService.atomicWrite({ path, content: source, replace: true });
    const checksum = `sha256:${createHash("sha256").update(source).digest("hex")}`;
    const context = { task_id: "TICKET-A", state: "verified", verification_artifact_id: "ARTIFACT-A", review_commit_sha: "a".repeat(40), source_revision: "source-1", manifest_sha: "manifest-1", base_sha: "b".repeat(40), manifest_paths: [path] };
    const artifact = { artifact_id: "ARTIFACT-A", commit_sha: context.review_commit_sha, source_revision: context.source_revision, manifest_sha: context.manifest_sha, base_sha: context.base_sha, file_checksums: { [path]: checksum }, status: "passed" };
    const job = { task_id: "TICKET-A", payload: { changed_paths: [path], base_commit: context.base_sha, commit: context.review_commit_sha, verification: { artifact_id: artifact.artifact_id } } };
    let head = context.review_commit_sha;
    let status = "";
    const inputs = { job, executionContexts: { load: async () => context }, verificationService: { assertPassedArtifact: async () => artifact }, gitService: { getHead: async () => head, status: async () => status }, fileService, projectRoot: root };
    const good = await assertTicketReviewEvidence(inputs);
    assert.equal(good.files[0].content, source);
    assert.equal(good.artifact.artifact_id, "ARTIFACT-A");
    head = "c".repeat(40);
    await assert.rejects(assertTicketReviewEvidence(inputs), { code: "REVIEW_COMMIT_STALE" });
    head = context.review_commit_sha;
    status = " M backend/src/feature.js";
    await assert.rejects(assertTicketReviewEvidence(inputs), { code: "REVIEW_COMMIT_STALE" });
    status = "";
    await fileService.atomicWrite({ path, content: "export const feature = false;\n", replace: true });
    await assert.rejects(assertTicketReviewEvidence(inputs), { code: "REVIEW_SOURCE_MISMATCH" });
    await fileService.atomicWrite({ path, content: source, replace: true });
    await assert.rejects(assertTicketReviewEvidence({ ...inputs, job: { ...job, payload: { ...job.payload, verification: { artifact_id: "ARTIFACT-OTHER" } } } }), { code: "REVIEW_EVIDENCE_MISMATCH" });
    await assert.rejects(assertTicketReviewEvidence({ ...inputs, job: { ...job, payload: { ...job.payload, commit: "d".repeat(40) } } }), { code: "REVIEW_EVIDENCE_MISMATCH" });
    await assert.rejects(assertTicketReviewEvidence({ ...inputs, verificationService: { assertPassedArtifact: async () => { throw Object.assign(new Error("missing artifact"), { code: "VERIFICATION_ARTIFACT_MISSING" }); } } }), { code: "VERIFICATION_ARTIFACT_MISSING" });
    const originalManifest = artifact.manifest_sha;
    artifact.manifest_sha = "manifest-other";
    await assert.rejects(assertTicketReviewEvidence(inputs), { code: "REVIEW_EVIDENCE_MISMATCH" });
    artifact.manifest_sha = originalManifest;
    const originalChecksum = artifact.file_checksums[path];
    artifact.file_checksums[path] = "sha256:wrong";
    await assert.rejects(assertTicketReviewEvidence(inputs), { code: "REVIEW_SOURCE_MISMATCH" });
    artifact.file_checksums[path] = originalChecksum;
  } finally { await rm(root, { recursive: true, force: true }); }
});
