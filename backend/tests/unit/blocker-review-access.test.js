// Tests exact-revision Reviewer access diagnostics without running agents, granting approval or changing findings.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { inspectBlockerReviewAccess } from "../../src/modules/supervisor/blocker-review-access.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

// Supplies real immutable Git objects and current role rules while allowing unrelated dirty workspace changes.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-review-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { "backend/router.js": "export const router = true;\n", "AGENTS.md": "Read project instructions.\n",
    "workflows/agents/reviewer/README.md": "Review without modifying files.\n" };
  for (const [path, content] of Object.entries(source)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  // Restricts all Git operations to disposable test repository setup and reads.
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  const artifact = { status: "passed", artifact_id: "ARTIFACT-REVIEW", commit_sha: commit, base_sha: commit,
    manifest_sha: "manifest", source_revision: "source", file_checksums: { "backend/router.js": `sha256:${createHash("sha256").update(source["backend/router.js"]).digest("hex")}` } };
  const prior = { task_id: "T", project_id: "P", review_commit_sha: commit, base_sha: commit, verification_artifact_id: artifact.artifact_id,
    manifest_sha: artifact.manifest_sha, source_revision: artifact.source_revision, manifest_paths: Object.keys(artifact.file_checksums) };
  return { root, artifact, input: { job: { request: { task_id: "T", project_id: "P", request_id: "R", correlation_id: "C" } },
    workspace: { projectRoot: root, fileService: createFileService({ projectRoot: root }) },
    checkpoint: { review_cycle_id: "CYCLE" }, context: { review_repair_cycle_id: "CYCLE" },
    reviewCheckpoint: { status: "completed", verdict: "request_changes", commit, verification: artifact, execution_context: prior } } };
}

test("historic read restriction is rechecked using actual Reviewer tools at the exact reviewed commit", async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify(f.input);
  await writeFile(join(f.root, "backend/router.js"), "unrelated current workspace changes\n");
  const result = await inspectBlockerReviewAccess(f.input);
  assert.equal(result.status, "verified");
  assert.equal(result.commit_sha, f.artifact.commit_sha);
  assert.equal(result.artifact_id, f.artifact.artifact_id);
  assert.equal(result.instructions, "readable");
  assert.equal(result.verdict, "unchanged");
  assert.equal(result.permissions, "project_read_only");
  assert.equal(JSON.stringify(f.input), before);
});

test("different ticket, artifact identity and changed checksums cannot produce verified access", async (t) => {
  const f = await fixture(t);
  for (const change of ["ticket", "artifact", "checksum"]) {
    const input = { ...f.input, reviewCheckpoint: structuredClone(f.input.reviewCheckpoint) };
    if (change === "ticket") input.reviewCheckpoint.execution_context.task_id = "OTHER";
    if (change === "artifact") input.reviewCheckpoint.execution_context.verification_artifact_id = "OTHER";
    if (change === "checksum") input.reviewCheckpoint.verification.file_checksums["backend/router.js"] = "wrong";
    const result = await inspectBlockerReviewAccess(input);
    assert.equal(result.status, "blocked");
    assert.equal(result.verdict, "unchanged");
  }
});

test("missing current Reviewer rules remain a tooling blocker and unrelated runs do not probe", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "workflows/agents/reviewer/README.md"));
  assert.equal((await inspectBlockerReviewAccess(f.input)).status, "blocked");
  assert.equal(await inspectBlockerReviewAccess({ ...f.input, checkpoint: {} }), null);
});
