// Replays only journaled ticket edits in its worktree before creating an isolated Git commit.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Labels commit reconstruction failures for the ticket pipeline.
const failure = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Builds ticket commits from durable deltas rather than from unrelated root changes.
export function createTicketCommitService({ taskId, ledger, worktreeFileService, gitService } = {}) {
  if (!taskId || !ledger?.snapshot || !worktreeFileService?.atomicWrite || !gitService?.commit) throw failure("CONFIGURATION_ERROR", "Ticket commit service requires a ledger, worktree, and Git Service.");
  return Object.freeze({ commit, status: gitService.status, diffWorkingTree: gitService.diffWorkingTree, diffPatchFrom: gitService.diffPatchFrom,
    getHead: gitService.getHead, getCommitParent: gitService.getCommitParent, getChangedFiles: gitService.getChangedFiles });

  // Replays journal entries once and commits only the ticket's recorded paths.
  async function commit(message, { paths = [] } = {}) {
    const manifest = await ledger.snapshot(taskId);
    const expected = Object.keys(manifest.entries).sort();
    if (!expected.length || paths.some((path) => !expected.includes(path))) throw failure("TICKET_COMMIT_SCOPE", "Commit paths are not in the ticket change ledger.");
    const lastCommitted = Math.max(0, ...Object.keys(manifest.commits).map(Number));
    if (manifest.commits[manifest.revision]) return { sha: manifest.commits[manifest.revision], repeated: true };
    const headBefore = await gitService.getHead();
    if (manifest.pending_commit?.revision === manifest.revision && headBefore !== manifest.pending_commit.base_head) {
      throw failure("TICKET_COMMIT_RECOVERY_CONFLICT", "Legacy pending commit has no transaction identity; review its commit and ledger before recovery.");
    }
    const operations = Object.values(manifest.entries).flatMap((entry) => entry.operations.map((item) => ({ ...item, path: entry.path })))
      .filter((item) => item.revision > lastCommitted).sort((a, b) => a.revision - b.revision);
    if (!operations.length) throw failure("GIT_EMPTY_COMMIT", "Ticket has no uncommitted changes.");
    for (const entry of Object.values(manifest.entries)) {
      const pending = entry.operations.filter((item) => item.revision > lastCommitted).sort((a, b) => a.revision - b.revision);
      if (pending.length) await reconcile(entry, pending, manifest);
    }
    const changed = await gitService.status({ paths: expected });
    if (!changed.trim()) throw failure("GIT_EMPTY_COMMIT", "Ticket delta produced no worktree changes.");
    const commitPaths = [];
    for (const path of expected) if ((await gitService.status({ paths: [path] })).trim()) commitPaths.push(path);
    await ledger.prepareCommit(taskId, manifest.revision, headBefore);
    const result = await gitService.commit(message, { paths: commitPaths });
    await ledger.recordCommit(taskId, manifest.revision, result.sha);
    return result;
  }

  // Advances a worktree file from any ledger snapshot to its final ticket content.
  async function reconcile(entry, pending, manifest) {
    const current = await readOptional(entry.path);
    const final = pending.at(-1).after;
    if (current === final) return;
    const approval = manifest.baseline_reconciliation;
    if (approval?.paths?.includes(entry.path)) {
      const actual = `sha256:${createHash("sha256").update(entry.initial_content ?? "").digest("hex")}`;
      if (!approval.approved || actual !== entry.initial_sha || approval.initial_sha !== entry.initial_sha || approval.base_sha !== await gitService.getHead()) throw failure("TICKET_RECONCILIATION_STALE", "Approved baseline identity does not match the ticket source.");
      if ((await gitService.status({ paths: [entry.path] })).trim()) throw failure("TICKET_RECONCILIATION_STALE", "Ticket worktree path changed before reconciliation.");
      if (approval.worktree_sha !== `sha256:${createHash("sha256").update(current ?? "").digest("hex")}`) throw failure("TICKET_RECONCILIATION_STALE", "Ticket worktree baseline differs from approved evidence.");
      await worktreeFileService.atomicWrite({ path: entry.path, content: final, replace: true });
      return;
    }
    const known = [entry.initial_content, ...entry.operations.map((item) => item.after)];
    if (known.includes(current)) {
      if (final === null) await worktreeFileService.deleteFile({ path: entry.path });
      else await worktreeFileService.atomicWrite({ path: entry.path, content: final, replace: current !== null });
      return;
    }
    if (current === null && entry.initial_content !== null && !(await gitService.status({ paths: [entry.path] })).trim()) {
      await worktreeFileService.atomicWrite({ path: entry.path, content: final, replace: false });
      return;
    }
    throw failure("TICKET_BASELINE_CONFLICT", `Worktree source differs from every ticket snapshot: ${entry.path}.`);
  }

  // Reads a worktree file while preserving new-file semantics.
  async function readOptional(path) {
    try { return await worktreeFileService.readFile({ path }); }
    catch (error) { if (error.code !== "ENOENT") throw error; return null; }
  }
}
