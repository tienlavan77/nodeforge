// Business purpose: Extends Node Git Service with rich read-only repository inspection (`inspectStatus`, `diff`, `log`, `show`, `blame`) and delegates governed branch/restore/stash workflows to `git-service-workflow.js`.
// Technical description: Bound to a Git Service instance so git-service.js and git-service-extended.js both stay well under the 250-line budget while sharing the same execution runner, lock, and audit hooks.

import { createHash } from "node:crypto";
import { createGitWorkflowServiceOps } from "./git-service-workflow.js";

const MAX_BLAME_LINES = 200;

// Business purpose: Builds the extended Git operations bound to a Git Service instance so git-service.js stays compact while sharing the same lock and audit hooks.
// Technical description: Accepts execute, runGit, guard, emit, validateRevision, validateBranch, validatePaths, gitError, and protectedBranches, and returns the extended method map.
export function createExtendedGitOperations(deps) {
  const {
    projectRoot,
    timeoutMs,
    execute,
    runGit,
    emit,
    status,
    currentBranch,
    validateRevision,
    validatePaths,
    gitError
  } = deps;

  const workflowOps = createGitWorkflowServiceOps(deps);

  return {
    inspectStatus,
    diff,
    log,
    show,
    blame,
    ...workflowOps
  };

  // Business purpose: Provides a rich, structured working-tree and branch status summary with optional path filtering.
  // Technical description: Combines porcelain status, branch name, HEAD SHA, and upstream ahead/behind counts into a backward-compatible status payload.
  async function inspectStatus({ paths = [] } = {}) {
    const safePaths = validatePaths(paths);
    const stdout = await status({ paths: safePaths });
    const branchName = (await currentBranch().catch(() => "")) || null;
    const headRes = await runGit(["rev-parse", "HEAD"], { cwd: projectRoot, timeout: timeoutMs });
    const headSha = headRes.exitCode === 0 ? headRes.stdout.trim() : null;
    let ahead = 0;
    let behind = 0;
    if (branchName) {
      const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: projectRoot, timeout: timeoutMs });
      if (upstream.exitCode === 0) {
        const counts = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: projectRoot, timeout: timeoutMs });
        if (counts.exitCode === 0) {
          const parts = counts.stdout.trim().split(/\s+/).map(Number);
          ahead = Number.isFinite(parts[0]) ? parts[0] : 0;
          behind = Number.isFinite(parts[1]) ? parts[1] : 0;
        }
      }
    }
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const stagedCount = lines.filter((line) => line[0] !== " " && line[0] !== "?").length;
    const modifiedCount = lines.filter((line) => line[1] !== " " && line[1] !== "?").length;
    const untrackedCount = lines.filter((line) => line.startsWith("??")).length;
    const conflictedCount = lines.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line)).length;
    return {
      stdout,
      branch: branchName,
      head_sha: headSha,
      ahead,
      behind,
      has_conflicts: conflictedCount > 0,
      clean: lines.length === 0,
      modified_count: modifiedCount,
      untracked_count: untrackedCount,
      staged_count: stagedCount,
      working_tree: lines.length ? "dirty" : "clean",
      changed_files: lines.length,
      staged_files: stagedCount,
      unstaged_files: modifiedCount,
      untracked_files: untrackedCount,
      conflicted_files: conflictedCount
    };
  }

  // Business purpose: Reads scoped working-tree, staged, or commit-to-commit diffs with configurable context and stat-only mode to prevent oversized diff payloads.
  // Technical description: Validates optional base, head, unified context lines, staged flag, stat_only flag, and path filters before invoking git diff.
  async function diff({ paths = [], base, head, staged = false, stat_only = false, unified } = {}) {
    const safePaths = validatePaths(paths);
    if (base !== undefined) validateRevision(base);
    if (head !== undefined) validateRevision(head);
    if (head !== undefined && base === undefined) throw gitError("GIT_DIFF_INVALID", "git_diff head requires base revision.");
    if (unified !== undefined && (!Number.isInteger(unified) || unified < 0 || unified > 20)) {
      throw gitError("GIT_DIFF_INVALID", "git_diff unified must be an integer between 0 and 20.");
    }
    const args = ["diff", "--no-ext-diff"];
    if (staged) args.push("--cached");
    if (stat_only) args.push("--stat");
    if (unified !== undefined) args.push(`--unified=${unified}`);
    if (base !== undefined) args.push(base);
    if (head !== undefined) args.push(head);
    args.push("--", ...safePaths);
    const result = await execute(args, "GIT_DIFF_FAILED");
    if (result.exitCode !== 0) throw gitError("GIT_DIFF_FAILED", `Git diff failed: ${result.stderr ?? "unknown Git error"}`);
    emit("git.diff", { paths: safePaths, staged: Boolean(staged), stat_only: Boolean(stat_only), output_bytes: Buffer.byteLength(result.stdout) });
    return result.stdout;
  }

  // Business purpose: Retrieves structured commit history for repository investigation without shell access.
  // Technical description: Runs git log with NUL/field delimiters, optional revision, grep filter, path scope, and bounded limit (1..100, default 20).
  async function log({ limit = 20, path, paths = [], revision, grep } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw gitError("GIT_LOG_INVALID", "git_log limit must be an integer between 1 and 100.");
    if (revision !== undefined) validateRevision(revision);
    if (grep !== undefined && (typeof grep !== "string" || !grep.trim() || grep.length > 200)) {
      throw gitError("GIT_LOG_INVALID", "git_log grep must be a non-empty string up to 200 characters.");
    }
    const pathList = path !== undefined ? [path, ...paths] : paths;
    const safePaths = validatePaths(pathList);
    const format = "%H%x1f%h%x1f%an <%ae>%x1f%aI%x1f%s%x1f%b%x1e";
    const args = ["log", "-n", String(limit), `--format=${format}`];
    if (grep !== undefined) args.push(`--grep=${grep}`);
    if (revision !== undefined) args.push(revision);
    if (safePaths.length) args.push("--", ...safePaths);
    const result = await execute(args, "GIT_LOG_FAILED");
    if (result.exitCode !== 0) throw gitError("GIT_LOG_FAILED", `Git log failed: ${result.stderr ?? "unknown Git error"}`);
    const commits = result.stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [sha = "", short_sha = "", author = "", date = "", subject = "", body = ""] = record.split("\x1f");
        return { sha: sha.trim(), short_sha: short_sha.trim(), author: author.trim(), date: date.trim(), subject: subject.trim(), body: body.trim() };
      });
    emit("git.log", { count: commits.length, paths: safePaths });
    return { commits };
  }

  // Business purpose: Inspects either a single file at a historical revision (with sha256) or a commit's metadata, changed files, and patch without altering the working tree.
  // Technical description: Uses git show <revision>:<path> for file inspection or git show with formatted commit headers and diff/stat output for commit inspection.
  async function show({ revision, path, paths = [], stat_only = false } = {}) {
    validateRevision(revision);
    if (path !== undefined) {
      const [safePath] = validatePaths([path]);
      const result = await execute(["show", `${revision}:${safePath}`], "GIT_SHOW_FAILED");
      if (result.exitCode !== 0) throw gitError("GIT_SHOW_FAILED", `Git show failed for ${revision}:${safePath}: ${result.stderr ?? "unknown Git error"}`);
      const sha256 = `sha256:${createHash("sha256").update(result.stdout, "utf8").digest("hex")}`;
      const totalLines = result.stdout.length === 0 ? 0 : result.stdout.replace(/\r?\n$/, "").split(/\r?\n/).length;
      emit("git.show", { revision, path: safePath, mode: "file" });
      return {
        revision,
        path: safePath,
        content: result.stdout,
        sha256,
        total_lines: totalLines,
        size_bytes: Buffer.byteLength(result.stdout, "utf8")
      };
    }
    const safePaths = validatePaths(paths);
    const metaRes = await execute(["show", "-s", "--format=%H%x1f%h%x1f%an <%ae>%x1f%aI%x1f%s%x1f%b", revision], "GIT_SHOW_FAILED");
    if (metaRes.exitCode !== 0) throw gitError("GIT_SHOW_FAILED", `Git show failed for ${revision}: ${metaRes.stderr ?? "unknown Git error"}`);
    const [sha = "", short_sha = "", author = "", date = "", subject = "", body = ""] = metaRes.stdout.split("\x1f");
    const filesRes = await execute(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revision, ...(safePaths.length ? ["--", ...safePaths] : [])], "GIT_SHOW_FAILED");
    const changedFiles = filesRes.exitCode === 0 ? filesRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    const patchArgs = ["show", "--format=", ...(stat_only ? ["--stat"] : ["--patch", "--unified=3"]), revision, ...(safePaths.length ? ["--", ...safePaths] : [])];
    const patchRes = await execute(patchArgs, "GIT_SHOW_FAILED");
    if (patchRes.exitCode !== 0) throw gitError("GIT_SHOW_FAILED", `Git show patch failed: ${patchRes.stderr ?? "unknown Git error"}`);
    emit("git.show", { revision, paths: safePaths, mode: "commit", stat_only: Boolean(stat_only) });
    return {
      revision,
      commit: { sha: sha.trim(), short_sha: short_sha.trim(), author: author.trim(), date: date.trim(), subject: subject.trim(), body: body.trim() },
      changed_files: changedFiles,
      stdout: patchRes.stdout
    };
  }

  // Business purpose: Provides line-by-line commit attribution for a project file within a bounded line range (max 200 lines).
  // Technical description: Runs git blame --line-porcelain with -L start,end and parses commit SHA, author, ISO timestamp, line number, and line content.
  async function blame({ path, start_line = 1, end_line } = {}) {
    const [safePath] = validatePaths([path]);
    if (!Number.isInteger(start_line) || start_line < 1) throw gitError("GIT_BLAME_INVALID", "git_blame start_line must be a positive integer.");
    const effectiveEnd = end_line === undefined ? start_line + MAX_BLAME_LINES - 1 : end_line;
    if (!Number.isInteger(effectiveEnd) || effectiveEnd < start_line) {
      throw gitError("GIT_BLAME_INVALID", "git_blame end_line must be an integer >= start_line.");
    }
    if (effectiveEnd - start_line + 1 > MAX_BLAME_LINES) {
      throw gitError("GIT_BLAME_RANGE_TOO_LARGE", `git_blame range cannot exceed ${MAX_BLAME_LINES} lines per call.`);
    }
    const result = await execute(["blame", "--line-porcelain", "-L", `${start_line},${effectiveEnd}`, "--", safePath], "GIT_BLAME_FAILED");
    if (result.exitCode !== 0) throw gitError("GIT_BLAME_FAILED", `Git blame failed: ${result.stderr ?? "unknown Git error"}`);
    const lines = parseBlamePorcelain(result.stdout);
    emit("git.blame", { path: safePath, start_line, end_line: effectiveEnd, line_count: lines.length });
    return { path: safePath, start_line, end_line: effectiveEnd, lines };
  }
}

// Business purpose: Parses git blame --line-porcelain output into structured attribution records for agent inspection.
// Technical description: Iterates over porcelain header lines and tab-prefixed source lines to extract commit_sha, author, ISO timestamp, line_number, and content.
function parseBlamePorcelain(stdout = "") {
  const rawLines = stdout.split(/\r?\n/);
  const entries = [];
  let current = null;
  for (const line of rawLines) {
    if (!current) {
      const match = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line);
      if (match) current = { commit_sha: match[1], line_number: Number(match[2]), author: "", timestamp: "" };
      continue;
    }
    if (line.startsWith("author ")) {
      current.author = line.slice(7).trim();
    } else if (line.startsWith("author-time ")) {
      const sec = Number(line.slice(12).trim());
      if (Number.isFinite(sec)) current.timestamp = new Date(sec * 1000).toISOString();
    } else if (line.startsWith("\t")) {
      current.content = line.slice(1);
      entries.push(current);
      current = null;
    }
  }
  return entries;
}
