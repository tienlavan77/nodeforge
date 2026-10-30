// Supplies immutable project source and baseline diffs for independent ticket review.
import { createHash } from "node:crypto";
import { assertRoleFileAccess } from "../../../infrastructure/filesystem/file-service-role-policy.js";
import { createTicketRootGit } from "../ticket/ticket-root-git.js";
import { isDependencyPath } from "../../../infrastructure/filesystem/dependency-read.js";

// Pins read-only review evidence to Node-selected revisions, never mutable HEAD or model input.
export function createCommittedReviewSource({ projectRoot, commit, baseCommit, ticketEvidence, git = createTicketRootGit({ projectRoot }) }) {
  // Defines fail function behavior for reviewer-committed-source.js.
  const fail = (code, message) => Object.assign(new Error(message), { code });
  // Recognizes workspace-only cleanup using passed evidence bound to this exact review,
  // without treating final absence as proof of original bytes or inventing a Git deletion.
  function verifiedAbsence(path) {
    const { context, artifact, files } = ticketEvidence ?? {};
    return artifact?.status === "passed" && artifact.pre_commit !== true
      && artifact.artifact_id && context?.verification_artifact_id === artifact.artifact_id
      && artifact.commit_sha === commit && context.review_commit_sha === commit
      && artifact.base_sha && artifact.base_sha === context.base_sha
      && artifact.source_revision && artifact.source_revision === context.source_revision
      && artifact.manifest_sha && artifact.manifest_sha === context.manifest_sha
      && context.manifest_paths?.includes(path)
      && Object.hasOwn(artifact.file_checksums ?? {}, path) && artifact.file_checksums[path] === null
      && files?.some((file) => file.path === path && file.deleted === true && file.sha256 === null && file.content === null);
  }
  // Rejects revision expressions and unsafe committed file types before reading any blob.
  async function check(path, revision, optional = false) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision ?? "")) throw fail("REVIEW_REVISION_INVALID", "Review requires a fixed commit SHA.");
    assertRoleFileAccess("reviewer", "read", path);
    if (isDependencyPath(path)) throw fail("FILE_ROLE_FORBIDDEN", "Dependency reads require recorded verification environment evidence.");
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
    const gitPaths = [];
    const notes = [];
    for (const path of paths) {
      const before = await check(path, baseCommit, true);
      const after = await check(path, commit, true);
      if (!before && !after) {
        if (!verifiedAbsence(path)) throw fail("ENOENT", "Diff path absent from both review revisions.");
        notes.push(`Review manifest evidence for ${JSON.stringify(path)}: no Git delta; absent from both pinned revisions. The passed verification manifest confirms final absence. Original workspace bytes are not present in these Git revisions.`);
      } else gitPaths.push(path);
    }
    const diff = gitPaths.length ? await git.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", baseCommit, commit, "--", ...gitPaths.map((path) => `:(literal)${path}`)], { maxBuffer: 200_001 }) : "";
    const patch = notes.length ? [diff, ...notes].filter(Boolean).join("\n\n") : diff;
    if (Buffer.byteLength(patch) > 200_000) throw fail("REVIEW_EVIDENCE_TOO_LARGE", "Review diff exceeds the read budget.");
    return patch;
  }
  // Discovers only regular, role-readable blobs in the pinned tree, never filenames from mutable source.
  async function listFiles() {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit ?? "")) throw fail("REVIEW_REVISION_INVALID", "Review requires a fixed commit SHA.");
    const tree = await git.run(["ls-tree", "-r", "-z", "--full-tree", commit], { maxBuffer: 1_000_001 });
    if (Buffer.byteLength(tree) > 1_000_000) throw fail("REVIEW_EVIDENCE_TOO_LARGE", "Snapshot discovery exceeds its filename budget.");
    const paths = [];
    for (const entry of tree.split("\0").filter(Boolean)) {
      const match = entry.match(/^(100644|100755) blob [a-f0-9]+\t([\s\S]+)$/);
      if (!match) continue;
      try { assertRoleFileAccess("reviewer", "read", match[2]); }
      catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") continue; throw error; }
      if (/[\r\n]/.test(match[2]) || isDependencyPath(match[2])) continue;
      paths.push(match[2]);
    }
    return paths.sort();
  }
  // Derives safe directory ancestors from the same committed filename set used by snapshot searches.
  async function listDirectories() {
    return [...new Set((await listFiles()).flatMap((path) => path.split("/").slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join("/"))))].sort();
  }
  return { committedReview: true, reviewCommit: commit, readForIndex, diffPatchFrom, listFiles, listDirectories };
}
