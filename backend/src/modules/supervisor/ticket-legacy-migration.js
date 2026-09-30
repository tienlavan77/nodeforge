// Migrates a ticket's pre-ledger worktree history into audited root file claims.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";

const execFile = promisify(execFileCallback);
// Labels migration conflicts without altering an existing ticket branch.
const failure = (message) => Object.assign(new ConfigurationError(message), { code: "TICKET_MIGRATION_CONFLICT" });

// Imports only committed and mirrored dirty source, preserving the ticket worktree.
export async function migrateLegacyTicket({ taskId, worktree, baseCommit, rootFileService, worktreeFileService, ledger, projectLogger = () => {} }) {
  const git = async (args) => (await execFile("git", ["-C", worktree, ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 })).stdout;
  const headCommit = (await git(["rev-parse", "HEAD"])).toString().trim();
  const ancestor = await execFile("git", ["-C", worktree, "merge-base", baseCommit, headCommit]);
  if (ancestor.stdout.trim() !== baseCommit) throw failure("Legacy ticket base is not an ancestor of its worktree HEAD.");
  const committed = (await git(["diff", "--name-only", "-z", baseCommit, headCommit])).toString().split("\0").filter(Boolean);
  const status = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toString().split("\0").filter(Boolean);
  const dirty = [];
  for (const row of status) {
    const path = row.slice(3);
    if (["node_modules", "backend/node_modules", "ui/nextjs/node_modules"].includes(path)) continue;
    if (row[0] !== " " && row.slice(0, 2) !== "??") throw failure(`Staged or renamed worktree path needs separate migration: ${path}.`);
    dirty.push(path);
  }
  const paths = [...new Set([...committed, ...dirty])].sort();
  if (!paths.length) throw failure("Legacy ticket worktree has no changes.");
  const entries = {};
  for (const path of paths) {
    if (!path || path.startsWith(".") || path.includes("..") || path.includes("\\") || path.split("/").some((part) => part.startsWith("."))) throw failure(`Unsafe legacy source path: ${path}.`);
    let content;
    try { content = (await git(["show", `HEAD:${path}`])).toString(); }
    catch (error) {
      if (!dirty.includes(path)) throw failure(`Committed source cannot be read: ${path} (${error.message}).`);
      content = null;
    }
    let root;
    try { root = await rootFileService.readFile({ path }); }
    catch (error) { if (error.code !== "ENOENT") throw error; root = null; }
    if (dirty.includes(path)) {
      const worktreeContent = await worktreeFileService.readFile({ path });
      if (root !== worktreeContent) throw failure(`Root and worktree differ for uncommitted path: ${path}.`);
    } else if (root !== content) throw failure(`Root differs from committed ticket path: ${path}.`);
    entries[path] = { committed: content, root };
  }
  const result = await ledger.importLegacy(taskId, { baseCommit, headCommit, entries });
  projectLogger({ event_name: "ticket.legacy_migration_completed", level: "info", status: "success", message: "Ticket worktree migrated without changing its source or commits.", task_id: taskId, source: "ticket-legacy-migration", payload: { head_commit: headCommit, committed_count: committed.length, dirty_count: dirty.length } });
  return { head_commit: headCommit, paths, pending_paths: dirty, revision: result.revision };
}
