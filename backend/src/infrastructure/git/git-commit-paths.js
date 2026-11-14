// Selects commit candidates using Git's own tracked-file and ignore rules.
// Business purpose: keeps runtime outputs out of agent commits while preserving tracked edits and deletions.
// Technical description: combines tracked paths, visible untracked paths and staged deletions using NUL-delimited Git output.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

// Reads the committable inventory without staging or changing the root workspace.
// Git evaluates nested ignore files, negations and local/global excludes; tracked files remain eligible.
// Non-repository workspaces return null for filesystem-only tools, while other Git errors remain visible.
export async function gitCommitPaths(projectRoot, execute = null) {
  const run = execute ?? (async (args) => {
    try {
      const result = await exec("git", args, { cwd: projectRoot, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
      return { ...result, exitCode: 0 };
    } catch (error) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, exitCode: error.code };
    }
  });
  const result = await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.exitCode !== 0) {
    if (/not a git repository/i.test(result.stderr ?? "")) return null;
    throw Object.assign(new Error(`Git commit inventory failed: ${result.stderr}`), { code: "GIT_STATUS_FAILED" });
  }
  const deleted = await run(["diff", "--cached", "--name-only", "--diff-filter=D", "-z"]);
  if (deleted.exitCode !== 0) throw Object.assign(new Error(`Git deletion inventory failed: ${deleted.stderr}`), { code: "GIT_STATUS_FAILED" });
  const ignored = await run(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]);
  if (ignored.exitCode !== 0) throw Object.assign(new Error(`Git ignore inventory failed: ${ignored.stderr}`), { code: "GIT_STATUS_FAILED" });
  const excluded = new Set(ignored.stdout.split("\0").filter(Boolean));
  const paths = result.stdout.split("\0").filter((path) => path && !excluded.has(path));
  // Explicit staged removals remain committable so cleanup can untrack outputs without deleting local data.
  const deletedPaths = deleted.stdout.split("\0").filter(Boolean);
  return Object.assign(new Set([...paths, ...deletedPaths]), { staged_deletions: deletedPaths });
}
