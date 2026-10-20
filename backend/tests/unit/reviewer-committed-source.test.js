// Verifies immutable Reviewer reads and diffs without creating commits or modifying project source.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCommittedReviewSource } from "../../src/modules/supervisor/reviewer-committed-source.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const commit = "a".repeat(40);
const baseCommit = "b".repeat(40);

// Supplies revision-specific blobs and modes to exercise read policy without Git mutations.
function fixture({ mode = "100644", content = "committed source\n", before = "100644", after = mode } = {}) {
  const calls = [];
  const git = { assertSafePath: async () => {}, modeAt: async (revision) => revision === commit ? after : before,
    run: async (args, options) => { calls.push({ args, options }); return args[0] === "diff" ? "-old\n+new\n" : content; } };
  return { calls, source: createCommittedReviewSource({ projectRoot, commit, baseCommit, git }) };
}

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
  const path = "backend/src/modules/supervisor/review-worker.js";
  assert.equal((await source.readForIndex({ path })).content, await git.fileAt(head, path));
  assert.equal(await source.diffPatchFrom(base, { paths: [path] }), await git.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, head, "--", `:(literal)${path}`]));
});
