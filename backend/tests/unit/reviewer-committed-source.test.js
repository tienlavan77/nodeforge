// Verifies immutable Reviewer reads and diffs without creating commits or modifying project source.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCommittedReviewSource } from "../../src/modules/supervisor/review/reviewer-committed-source.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket/ticket-root-git.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const commit = "a".repeat(40);
const baseCommit = "b".repeat(40);

// Supplies revision-specific blobs and modes to exercise read policy without Git mutations.
function fixture({ mode = "100644", content = "committed source\n", before = "100644", after = mode, ticketEvidence } = {}) {
  const calls = [];
  const git = { assertSafePath: async () => {}, modeAt: async (revision) => revision === commit ? after : before,
    run: async (args, options) => { calls.push({ args, options }); return args[0] === "diff" ? "-old\n+new\n" : content; } };
  return { calls, source: createCommittedReviewSource({ projectRoot, commit, baseCommit, ticketEvidence, git }) };
}

// Supplies exact verification bindings for cleanup of a file never tracked by Git.
function deletionEvidence(path = "workspace-only.md") {
  return { context: { verification_artifact_id: "ARTIFACT-1", review_commit_sha: commit, base_sha: baseCommit,
    source_revision: "SOURCE-1", manifest_sha: "MANIFEST-1", manifest_paths: [path] },
  artifact: { status: "passed", artifact_id: "ARTIFACT-1", commit_sha: commit, base_sha: baseCommit,
    source_revision: "SOURCE-1", manifest_sha: "MANIFEST-1", file_checksums: { [path]: null } },
  files: [{ path, deleted: true, sha256: null, content: null }] };
}

test("verified workspace-only cleanup carries an absence receipt without inventing a Git deletion", async () => {
  const { source, calls } = fixture({ before: null, after: null, ticketEvidence: deletionEvidence() });
  const patch = await source.diffPatchFrom(baseCommit, { paths: ["workspace-only.md"] });
  assert.match(patch, /workspace-only\.md.*no Git delta/);
  assert.match(patch, /passed verification manifest confirms final absence/);
  assert.match(patch, /Original workspace bytes are not present/);
  assert.doesNotMatch(patch, /diff --git|deleted file mode|^-/m);
  assert.equal(calls.length, 0);
  await assert.rejects(() => source.readForIndex({ path: "workspace-only.md" }), { code: "ENOENT" });
  await assert.rejects(() => source.diffPatchFrom(baseCommit, { paths: ["unknown.md"] }), { code: "ENOENT" });
});

test("absent paths require complete passed evidence for the exact reviewed revision", async () => {
  for (const mutate of [
    (e) => { e.artifact.status = "failed"; }, (e) => { e.artifact.pre_commit = true; },
    (e) => { e.artifact.commit_sha = baseCommit; }, (e) => { e.context.review_commit_sha = baseCommit; },
    (e) => { e.artifact.base_sha = commit; }, (e) => { e.artifact.artifact_id = "OTHER"; },
    (e) => { e.artifact.source_revision = "OTHER"; }, (e) => { e.artifact.manifest_sha = "OTHER"; },
    (e) => { e.context.manifest_paths = []; }, (e) => { delete e.artifact.file_checksums["workspace-only.md"]; },
    (e) => { e.artifact.file_checksums["workspace-only.md"] = "sha256:exists"; },
    (e) => { e.files = []; }, (e) => { e.files[0].deleted = false; },
    (e) => { e.files[0].sha256 = "sha256:exists"; }, (e) => { e.files[0].content = "original"; }
  ]) {
    const ticketEvidence = deletionEvidence();
    mutate(ticketEvidence);
    await assert.rejects(() => fixture({ before: null, after: null, ticketEvidence }).source.diffPatchFrom(baseCommit, { paths: ["workspace-only.md"] }), { code: "ENOENT" });
  }
});

test("mixed review paths retain real Git patches and absence notes, including repair baselines", async () => {
  const calls = [];
  const git = { modeAt: async (_revision, path) => path === "workspace-only.md" ? null : "100644",
    run: async (args) => { calls.push(args); return "diff --git a/source.js b/source.js\n-old\n+new\n"; } };
  const previous = "c".repeat(40);
  const source = createCommittedReviewSource({ projectRoot, commit, baseCommit: previous, git, ticketEvidence: deletionEvidence() });
  const patch = await source.diffPatchFrom(previous, { paths: ["source.js", "workspace-only.md"] });
  assert.match(patch, /diff --git a\/source.js/);
  assert.match(patch, /workspace-only.md.*no Git delta/);
  assert.deepEqual(calls[0].slice(5), [previous, commit, "--", ":(literal)source.js"]);
});

test("verified absence preserves path policy and the combined diff output budget", async () => {
  for (const path of ["../outside", ".env", "node_modules/sample.js"]) {
    await assert.rejects(() => fixture({ before: null, after: null, ticketEvidence: deletionEvidence(path) })
      .source.diffPatchFrom(baseCommit, { paths: [path] }), { code: "FILE_ROLE_FORBIDDEN" });
  }
  const source = createCommittedReviewSource({ projectRoot, commit, baseCommit, ticketEvidence: deletionEvidence(),
    git: { modeAt: async (_revision, path) => path === "workspace-only.md" ? null : "100644", run: async () => "x".repeat(199_999) } });
  await assert.rejects(() => source.diffPatchFrom(baseCommit, { paths: ["source.js", "workspace-only.md"] }), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
});

test("source and diff use only pinned revisions and disable external Git filters", async () => {
  const { source, calls } = fixture();
  assert.equal((await source.readForIndex({ path: "AGENTS.md" })).content, "committed source\n");
  assert.equal(await source.diffPatchFrom(baseCommit, { paths: ["backend/scripts/start-control-api.mjs"] }), "-old\n+new\n");
  assert.deepEqual(calls[0].args, ["show", `${commit}:AGENTS.md`]);
  assert.deepEqual(calls[1].args, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", baseCommit, commit, "--", ":(literal)backend/scripts/start-control-api.mjs"]);
  assert.equal(calls[0].options.maxBuffer, 64_001);
  assert.equal(calls[1].options.maxBuffer, 200_001);
  await assert.rejects(() => source.diffPatchFrom("HEAD", { paths: ["AGENTS.md"] }), { code: "REVIEW_REVISION_INVALID" });
});

test("review rejects protected paths, symbolic blobs, binary files and oversized reads", async () => {
  const { source, calls } = fixture();
  for (const path of ["../outside", "/outside", ".forge/runtime/data", ".env", "node_modules/package/index.js", "secrets/key"]) {
    await assert.rejects(() => source.readForIndex({ path }), { code: "FILE_ROLE_FORBIDDEN" });
  }
  assert.equal(calls.length, 0);
  for (const mode of ["120000", "160000", "040000"]) {
    await assert.rejects(() => fixture({ mode }).source.readForIndex({ path: "AGENTS.md" }), { code: "FILE_ROLE_FORBIDDEN" });
  }
  await assert.rejects(() => fixture({ content: "binary\0data" }).source.readForIndex({ path: "AGENTS.md" }), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(() => fixture({ content: "x".repeat(64_001) }).source.readForIndex({ path: "AGENTS.md" }), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
  await assert.rejects(() => createCommittedReviewSource({ projectRoot, commit: "HEAD", baseCommit }).readForIndex({ path: "AGENTS.md" }), { code: "REVIEW_REVISION_INVALID" });
});

test("diff permits added and deleted files but never symbolic files on either side", async () => {
  for (const [before, after] of [[null, "100644"], ["100644", null]]) {
    assert.match(await fixture({ before, after }).source.diffPatchFrom(baseCommit, { paths: ["AGENTS.md"] }), /new/);
  }
  for (const [before, after] of [["120000", "100644"], ["100644", "120000"]]) {
    await assert.rejects(() => fixture({ before, after }).source.diffPatchFrom(baseCommit, { paths: ["AGENTS.md"] }), { code: "FILE_ROLE_FORBIDDEN" });
  }
  await assert.rejects(() => fixture({ before: null, after: null }).source.diffPatchFrom(baseCommit, { paths: ["AGENTS.md"] }), { code: "ENOENT" });
});

test("real repository reads and diffs match immutable objects, not current dirty source", async () => {
  const git = createTicketRootGit({ projectRoot });
  const head = (await git.run(["rev-parse", "HEAD"])).trim();
  const base = (await git.run(["rev-parse", "HEAD^"])).trim();
  const source = createCommittedReviewSource({ projectRoot, commit: head, baseCommit: base });
  const path = "backend/src/modules/supervisor/review/review-worker.js";
  assert.equal((await source.readForIndex({ path })).content, await git.fileAt(head, path));
  assert.equal(await source.diffPatchFrom(base, { paths: [path] }), await git.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, head, "--", `:(literal)${path}`]));
});
