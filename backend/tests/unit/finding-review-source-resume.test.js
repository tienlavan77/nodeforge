// Verifies evidence-only repairs reuse immutable review source without duplicate commits or adopting other agents' files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { prepareFindingReviewRepair } from "../../src/modules/supervisor/finding-review-repair-workspace.js";
import { resumeFindingReviewSource, inspectFindingReviewSource } from "../../src/modules/supervisor/review/finding-review-source-resume.js";

// Seeds a genuinely archived verified repair with independent dirty workspace content.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-finding-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const taskId = "TICKET-1", projectId = "PROJECT-1", content = "const fixed = true;\n";
  const manifestPath = `.forge/runtime/ticket-changes/${hash(projectId)}/tickets/${hash(taskId)}.json`;
  const contextPath = `.forge/runtime/ticket-execution-contexts/${hash(projectId)}/${taskId}.json`;
  const contexts = createTicketExecutionContextStore({ projectId, projectRoot: root, fileService: files });
  const manifest = { task_id: taskId, project_id: projectId, state: "active", revision: 8,
    entries: { "source.js": { latest_sha: `sha256:${hash(content)}`, operations: [] } }, commits: { 8: "a".repeat(40) }, pending_commit: null };
  const context = { task_id: taskId, project_id: projectId, version: 3, state: "reviewing", base_sha: "b".repeat(40),
    supervisor_id: "SV-1", ...contexts.manifestIdentity(manifest), review_commit_sha: "a".repeat(40), verification_artifact_id: "ARTIFACT-1" };
  const artifact = { task_id: taskId, status: "passed", artifact_id: "ARTIFACT-1", commit_sha: context.review_commit_sha,
    source_revision: context.source_revision, manifest_sha: context.manifest_sha, base_sha: context.base_sha,
    file_checksums: { "source.js": manifest.entries["source.js"].latest_sha } };
  const artifactPath = `.forge/runtime/ticket-verification/${taskId}/artifacts/ARTIFACT-1.json`;
  for (const [path, value] of [[manifestPath, manifest], [contextPath, context], [artifactPath, artifact]])
    await files.atomicWrite({ path, content: JSON.stringify(value) });
  await files.atomicWrite({ path: "source.js", content: "newer foreign work remains untouched" });
  const ledger = createTicketChangeLedger({ projectId, fileService: files });
  const options = { taskId, projectId, fileService: files, executionContexts: contexts, ledger,
    rootGit: { assertAncestor: async () => {}, fileAt: async () => content } };
  await prepareFindingReviewRepair({ ...options, testService: { assertPassedArtifact: async () => artifact }, reviewKey: `sha256:${"d".repeat(64)}` });
  return { options, files, contexts, ledger, manifest, context, artifactPath, contextPath, manifestPath };
}

test("unchanged repair restores the exact prior commit and artifact, preserving unrelated live source", async (t) => {
  const f = await fixture(t);
  const before = await f.contexts.load("TICKET-1");
  const inspection = await inspectFindingReviewSource(f.options);
  assert.equal(inspection.commit_sha, f.context.review_commit_sha);
  assert.deepEqual(await f.contexts.load("TICKET-1"), before);
  assert.equal(await resumeFindingReviewSource(f.options), true);
  assert.equal((await f.contexts.load("TICKET-1")).review_commit_sha, f.context.review_commit_sha);
  assert.equal((await f.contexts.load("TICKET-1")).verification_artifact_id, "ARTIFACT-1");
  assert.deepEqual(await f.ledger.load("TICKET-1"), f.manifest);
  assert.equal(await f.files.readFile({ path: "source.js" }), "newer foreign work remains untouched");
  assert.equal(await resumeFindingReviewSource(f.options), false);
  const replay = await prepareFindingReviewRepair({ ...f.options, testService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1" }) }, reviewKey: `sha256:${"d".repeat(64)}` });
  assert.equal(replay.unchanged_source, true);
  assert.deepEqual(await f.ledger.load("TICKET-1"), f.manifest);
  const legacy = await f.contexts.load("TICKET-1"); delete legacy.resumed_finding_cycle_id;
  await f.files.atomicWrite({ path: f.contextPath, content: JSON.stringify(legacy), replace: true });
  assert.equal((await prepareFindingReviewRepair({ ...f.options, testService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1" }) }, reviewKey: `sha256:${"d".repeat(64)}` })).unchanged_source, true);
});

test("any new Coder write prevents archived source reuse", async (t) => {
  const f = await fixture(t);
  await f.ledger.write({ taskId: "TICKET-1", path: "extra.js", before: null, after: "const added = 1;" });
  assert.equal(await inspectFindingReviewSource(f.options), null);
  assert.equal(await resumeFindingReviewSource(f.options), false);
  assert.equal((await f.contexts.load("TICKET-1")).state, "coding");
  assert.ok((await f.ledger.load("TICKET-1")).entries["extra.js"]);
});

test("tampered artifact, Git source or execution identity cannot be relabeled as verified", async (t) => {
  for (const kind of ["artifact", "source", "context", "unreachable"]) {
    const f = await fixture(t);
    if (kind === "artifact") await f.files.atomicWrite({ path: f.artifactPath, content: '{"status":"passed"}', replace: true });
    if (kind === "source") f.options.rootGit.fileAt = async () => "different source";
    if (kind === "context") await f.files.atomicWrite({ path: f.contextPath, content: JSON.stringify({ ...await f.contexts.load("TICKET-1"), supervisor_id: "OTHER" }), replace: true });
    if (kind === "unreachable") f.options.rootGit.assertAncestor = async () => { throw new Error("Unreachable commit"); };
    await assert.rejects(resumeFindingReviewSource(f.options));
    assert.equal((await f.contexts.load("TICKET-1")).state, "coding");
  }
});

test("partial restore recovers after journal persistence without repeating source edits", async (t) => {
  const f = await fixture(t);
  const files = { ...f.files, atomicWrite: async (input) => {
    if (input.path === f.contextPath) throw new Error("simulated context write crash");
    return f.files.atomicWrite(input);
  } };
  await assert.rejects(resumeFindingReviewSource({ ...f.options, fileService: files }), /simulated context write crash/);
  assert.deepEqual(await f.ledger.load("TICKET-1"), f.manifest);
  assert.equal(await resumeFindingReviewSource(f.options), true);
  assert.equal((await f.contexts.load("TICKET-1")).state, "reviewing");
});
