// Supplies immutable project source and baseline diffs for independent ticket review.
import { createHash } from "node:crypto";
import { assertRoleFileAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { createTicketRootGit } from "./ticket-root-git.js";

// Pins read-only review evidence to Node-selected revisions, never mutable HEAD or model input.
export function createCommittedReviewSource({ projectRoot, commit, baseCommit, git = createTicketRootGit({ projectRoot }) }) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  // Rejects revision expressions and unsafe committed file types before reading any blob.
  async function check(path, revision, optional = false) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision ?? "")) throw fail("REVIEW_REVISION_INVALID", "Review requires a fixed commit SHA.");
    assertRoleFileAccess("reviewer", "read", path);
    await git.assertSafePath(path);
    const mode = await git.modeAt(revision, path);
    if (!mode && optional) return false;
    if (!mode) throw fail("ENOENT", "File absent from reviewed commit.");
    if (!["100644", "100755"].includes(mode)) throw fail("FILE_ROLE_FORBIDDEN", "Review requires a regular committed file.");
    return true;
  }
  // Reads bounded text directly from the reviewed Git object rather than the working tree.
  async function readForIndex({ path, maxBytes = 64_000 }) {
    await check(path, commit);
    const content = await git.run(["show", `${commit}:${path}`], { maxBuffer: 64_001 });
    const size = Buffer.byteLength(content);
    if (size > Math.min(maxBytes, 64_000)) throw fail("REVIEW_EVIDENCE_TOO_LARGE", "Committed source exceeds the read budget.");
    if (content.includes("\0")) throw fail("FILE_ROLE_FORBIDDEN", "Reviewer source must be text.");
    return { path, content, size_bytes: size, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  }
  // Produces an exact base-to-reviewed-commit patch without external diff programs or working-tree data.
  async function diffPatchFrom(base, { paths }) {
    if (base !== baseCommit || !Array.isArray(paths) || !paths.length || paths.length > 24) throw fail("REVIEW_REVISION_INVALID", "Review diff requires the fixed baseline and bounded paths.");
    for (const path of paths) {
      const before = await check(path, baseCommit, true);
      const after = await check(path, commit, true);
      if (!before && !after) throw fail("ENOENT", "Diff path absent from both review revisions.");
    }
    const patch = await git.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", baseCommit, commit, "--", ...paths.map((path) => `:(literal)${path}`)], { maxBuffer: 200_001 });
    if (Buffer.byteLength(patch) > 200_000) throw fail("REVIEW_EVIDENCE_TOO_LARGE", "Review diff exceeds the read budget.");
    return patch;
  }
  return { committedReview: true, readForIndex, diffPatchFrom, listFiles: async () => [], listDirectories: async () => [] };
}
