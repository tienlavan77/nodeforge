// Supplies Node-owned journal and Git facts so recovery does not ask agents to read protected runtime files.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../../shared/errors.js";

// Identifies file bytes without including source contents in recovery handoffs.
const sha = (value) => value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Observes the current parent and retained transaction without granting writes or inventing historical receipts.
export async function inspectTicketSource({ manifest, taskId, projectId, rootGit, gitService, loadJournal, loadManifest }) {
  if (manifest.task_id !== taskId || manifest.project_id !== projectId) throw Object.assign(new ConfigurationError("Source evidence belongs to another ticket or project."), { code: "TICKET_COMMIT_SCOPE" });
  const parent = (await gitService.getHead()).trim();
  const lastCommitted = Math.max(0, ...Object.keys(manifest.commits ?? {}).map(Number));
  const files = [];
  for (const [path, entry] of Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b))) {
    await rootGit.assertSafePath(path);
    const operations = [...(entry.operations ?? [])].sort((a, b) => a.revision - b.revision);
    const pending = operations.filter((item) => item.revision > lastCommitted);
    const states = operations.filter((item) => item.revision <= (pending[0]?.revision ?? Infinity))
      .flatMap((item) => [item.before_sha, item.after_sha]);
    const parentSha = sha(await rootGit.fileAt(parent, path));
    files.push({ path, source_reconciliation: entry.source_reconciliation ?? null, initial_sha: entry.initial_sha, latest_sha: entry.latest_sha, parent_file_sha256: parentSha,
      comparison: parentSha === entry.latest_sha ? "already_in_parent" : !pending.length ? "no_pending_operations"
        : states.includes(parentSha) ? "recorded_ticket_state" : "preexisting_changes",
      operations: operations.map(({ id, revision, before_sha, after_sha }) => ({ id, revision, before_sha, after_sha })) });
  }
  const journal = await loadJournal(manifest.revision);
  const stable = (await gitService.getHead()).trim() === parent && JSON.stringify(await loadManifest()) === JSON.stringify(manifest);
  const evidence = { project_id: projectId, task_id: taskId, revision: manifest.revision,
    commits: manifest.commits, pending_commit: manifest.pending_commit ?? null,
    observation: "current_parent_not_historical_failed_parent", parent_sha: parent, status: stable ? "observed" : "stale",
    commit_scope: "whole_ticket_files",
    transaction: journal ? { status: "retained", transaction_id: journal.transaction_id, revision: journal.revision,
      parent_sha: journal.parent_sha, phase: journal.phase, tree_sha: journal.tree_sha ?? null, commit_sha: journal.commit_sha ?? null }
      : { status: "missing", reason: "No retained transaction for this revision; a preflight failure may precede transaction creation. Historical failed parent is unknown unless the original receipt recorded it." },
    files };
  return { ...evidence, sha256: sha(JSON.stringify(evidence)) };
}
