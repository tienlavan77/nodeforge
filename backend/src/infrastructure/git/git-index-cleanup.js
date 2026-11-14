// Preserves explicit index-only removals while committing an agent's selected source paths.
// A generated file may remain on disk after untracking. A normal add or commit --only
// would track it again. This module uses a private index only for that case, isolates
// unrelated staging, and resets only committed source entries after the commit succeeds.
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Commits selected paths without resurrecting local files explicitly removed from the index.
// Returns null when ordinary commit handling is sufficient; errors preserve the original cause.
export async function commitIndexCleanup({ projectRoot, paths, deletedPaths = [], execute, message }) {
  const removed = [];
  for (const path of deletedPaths.filter((path) => paths.includes(path))) {
    try { await lstat(join(projectRoot, path)); removed.push(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!removed.length) return null;
  const directory = await mkdtemp(join(tmpdir(), "forge-commit-index-"));
  const options = { env: { ...process.env, GIT_INDEX_FILE: join(directory, "index") } };
  // Carries the private index through every Git phase and refuses failed subprocess results.
  async function run(args, privateIndex = true) {
    const result = await execute(args, "GIT_COMMIT_FAILED", privateIndex ? options : {});
    if (result.exitCode !== 0) throw Object.assign(new Error(result.stderr || "Git cleanup commit failed."), { code: "GIT_COMMIT_FAILED" });
    return result.stdout;
  }
  try {
    await run(["read-tree", "HEAD"]);
    const source = paths.filter((path) => !removed.includes(path));
    if (source.length) await run(["add", "--", ...source.map((path) => `:(literal)${path}`)]);
    await run(["update-index", "--force-remove", "--", ...removed]);
    const output = await run(["commit", "-m", message]);
    const sha = (await run(["rev-parse", "HEAD"])).trim();
    if (source.length) await run(["reset", "HEAD", "--", ...source.map((path) => `:(literal)${path}`)], false);
    return { sha, output, paths };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
