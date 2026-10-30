/** Keeps ticket review dispatch independent of the aggregate source size. A small
 * initial patch gives the Reviewer context; larger changes remain available through
 * the existing per-file review_diff and source-window tools at fixed revisions. */
const MAX_PROMPT_PATCH_BYTES = 32_000;

/** Reads patches per file so a valid multi-file ticket does not exceed the Git
 * adapter's single-diff limit before review starts. Omitted patches are named
 * explicitly; they are never silently truncated or treated as reviewed evidence. */
export async function readReviewPromptPatch({ baseCommit, source, paths }) {
  if (!baseCommit || !source?.diffPatchFrom) return "";
  const patches = [];
  const omitted = [];
  let bytes = 0;
  for (const path of paths) {
    let patch;
    try { patch = await source.diffPatchFrom(baseCommit, { paths: [path] }); }
    catch (error) {
      if (error.code !== "REVIEW_EVIDENCE_TOO_LARGE") throw error;
      omitted.push(path);
      continue;
    }
    const size = Buffer.byteLength(patch, "utf8");
    if (bytes + size > MAX_PROMPT_PATCH_BYTES) { omitted.push(path); continue; }
    patches.push(patch);
    bytes += size;
  }
  if (omitted.length) patches.push(`Patches omitted from initial prompt: ${JSON.stringify(omitted)}. Use review_diff for each file and read_lines for source windows before deciding.`);
  return patches.join("\n");
}
