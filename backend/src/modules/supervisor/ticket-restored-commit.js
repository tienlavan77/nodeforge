/** Reassociates a recorded ticket commit after diagnostic edits are completely
 * undone. The caller holds the project commit and ticket ledger locks. Every
 * ticket path must match its original receipt, immutable Git blob and live
 * bytes; unrelated project files are outside this comparison. No Git ref,
 * source file, approval or verification result is changed by this operation. */
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Identifies complete source bytes, preserving the distinction between absent and empty files.
const sha = (value) => value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
// Marks an inconsistent original receipt without converting it into a new commit or approval.
const conflict = () => Object.assign(new ConfigurationError("Restored ticket commit does not match its retained transaction receipt."), { code: "TICKET_COMMIT_RECOVERY_CONFLICT" });

/** Validates and journals a new ledger association to a previously recorded
 * same-ticket commit. Returns null when there is actual uncommitted work, so
 * normal commit/report gates remain responsible for that work. Journal-first
 * persistence makes a crash before recording the association recoverable. */
export async function reconcileRestoredTicketCommit({ taskId, projectId, manifest, record, rootGit, readOptional, loadJournal, saveJournal, manifestSha, projectLogger }) {
  if (manifest.task_id !== taskId || manifest.project_id !== projectId) throw conflict();
  const paths = Object.keys(manifest.entries).sort();
  const revisions = Object.keys(manifest.commits).map(Number).filter((revision) => revision <= manifest.revision).sort((a, b) => b - a);
  if (!paths.length || !revisions.length || manifest.pending_commit || manifest.state === "closed") return null;
  const revision = revisions[0], commit = manifest.commits[revision];
  const previous = await loadJournal(revision);
  if (!previous || previous.task_id !== taskId || previous.project_id !== projectId || previous.revision !== revision
    || previous.phase !== "receipt_persisted" || previous.commit_sha !== commit || !previous.path_checksums || !Array.isArray(previous.changed_paths)) throw conflict();
  const checksums = Object.fromEntries(paths.map((path) => [path, manifest.entries[path].latest_sha]));
  if (Object.entries(previous.path_checksums).some(([path, checksum]) => !Object.hasOwn(checksums, path) || checksums[path] !== checksum)) return null;
  const currentManifestSha = manifestSha(manifest);
  await rootGit.assertAncestor(commit);
  const parent = (await rootGit.run(["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/)[1];
  const tree = (await rootGit.run(["rev-parse", `${commit}^{tree}`])).trim();
  const body = await rootGit.run(["log", "-1", "--format=%B", commit]);
  if (parent !== previous.parent_sha || tree !== previous.tree_sha
    || !body.split("\n").includes(`X-Ticket-Tx: ${previous.transaction_id}`)) throw conflict();
  const changed = (await rootGit.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])).split("\n").filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...previous.changed_paths].sort())) throw conflict();
  for (const path of paths) {
    await rootGit.assertSafePath(path);
    if (sha(await rootGit.fileAt(commit, path)) !== checksums[path]) return null;
  }
  // Rechecks all paths, including files untouched by the latest diagnostic edit.
  async function assertSource() {
    for (const path of paths) {
      await rootGit.assertSafePath(path);
      if (sha(await rootGit.fileAt(commit, path)) !== checksums[path] || sha(await readOptional(path)) !== checksums[path])
        throw Object.assign(new ConfigurationError(`Restored ticket source differs from the recorded commit: ${path}.`), { code: "TICKET_SOURCE_DRIFT" });
    }
  }
  await assertSource();
  if (revision === manifest.revision) return { sha: commit, repeated: true, revision };
  const operations = Object.fromEntries(paths.map((path) => [path, manifest.entries[path].operations.map((item) => item.id)]));
  const claims = Object.fromEntries(paths.map((path) => [path, manifest.entries[path].claim_id ?? null]));
  const existing = await loadJournal(manifest.revision);
  if (existing && (existing.reconciliation !== "restored_source" || existing.reconciled_from_revision !== revision
    || existing.task_id !== taskId || existing.project_id !== projectId || existing.revision !== manifest.revision
    || existing.transaction_id !== previous.transaction_id || existing.commit_sha !== commit || existing.tree_sha !== tree
    || existing.parent_sha !== parent || existing.branch !== previous.branch
    || JSON.stringify(existing.changed_paths) !== JSON.stringify(previous.changed_paths)
    || existing.manifest_sha !== currentManifestSha || existing.phase !== "receipt_persisted"
    || JSON.stringify(existing.path_checksums) !== JSON.stringify(checksums)
    || JSON.stringify(existing.operation_ids) !== JSON.stringify(operations) || JSON.stringify(existing.claim_ids) !== JSON.stringify(claims))) throw conflict();
  if (!existing) await saveJournal({ ...previous, revision: manifest.revision, manifest_sha: currentManifestSha, path_checksums: checksums,
    reconciliation: "restored_source", reconciled_from_revision: revision, operation_ids: operations, claim_ids: claims, phase_trace: [] });
  await assertSource();
  await record(manifest.revision, commit);
  projectLogger({ event_name: "ticket.restored_commit_reconciled", level: "info", status: "success", task_id: taskId, project_id: projectId,
    source: "ticket-restored-commit", message: "Restored ticket source matched its retained commit; commit association reconciled.",
    payload: { commit_sha: commit, revision: manifest.revision, reconciled_from_revision: revision, path_count: paths.length } });
  return { sha: commit, repeated: true, restored: true, revision: manifest.revision };
}
