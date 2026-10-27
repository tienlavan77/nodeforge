/** Binds unchanged ticket source to an existing descendant commit when another
 * integration already committed those bytes. This records a source reference,
 * not commit authorship, and never stages files, moves Git refs, or supplies a
 * verification verdict. The caller holds the project and ticket commit locks. */
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Compares exact text bytes while preserving absent files in ticket manifests.
const sha = (value) => value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
// Keeps invalid provenance distinguishable from ordinary pending source changes.
const conflict = () => Object.assign(new ConfigurationError("Inherited ticket source lacks matching commit provenance."), { code: "TICKET_COMMIT_RECOVERY_CONFLICT" });

/** Reuses only a server-selected Git snapshot containing every recorded ticket
 * byte and descending from a proven ticket transaction. Journal-first storage
 * permits restart after recording the reference but before updating the ledger.
 * Uncommitted bytes return null so the ordinary commit path remains responsible. */
export async function reconcileInheritedTicketCommit({ taskId, projectId, manifest, record, rootGit, readOptional, loadJournal, saveJournal, manifestSha, projectLogger }) {
  if (manifest.task_id !== taskId || manifest.project_id !== projectId) throw conflict();
  const paths = Object.keys(manifest.entries).sort();
  if (!paths.length || manifest.pending_commit || manifest.state === "closed") return null;
  const existing = await loadJournal(manifest.revision);
  if (existing && existing.reconciliation !== "inherited_source") return null;
  const revisions = Object.keys(manifest.commits).map(Number).filter((revision) => revision < manifest.revision).sort((a, b) => b - a);
  let basis;
  for (const revision of revisions) {
    const saved = await loadJournal(revision);
    if (saved?.reconciliation === "inherited_source") continue;
    if (!saved || saved.task_id !== taskId || saved.project_id !== projectId || saved.revision !== revision
      || saved.phase !== "receipt_persisted" || saved.commit_sha !== manifest.commits[revision]
      || !saved.path_checksums || !Array.isArray(saved.changed_paths)) throw conflict();
    basis = saved;
    break;
  }
  if (!basis) return null;
  const commit = existing?.commit_sha ?? (await rootGit.run(["rev-parse", "HEAD"])).trim();
  await rootGit.assertAncestor(commit);
  await rootGit.run(["merge-base", "--is-ancestor", basis.commit_sha, commit]);
  const basisParent = (await rootGit.run(["rev-list", "--parents", "-n", "1", basis.commit_sha])).trim().split(/\s+/)[1];
  const basisTree = (await rootGit.run(["rev-parse", `${basis.commit_sha}^{tree}`])).trim();
  const body = await rootGit.run(["log", "-1", "--format=%B", basis.commit_sha]);
  const changed = (await rootGit.run(["diff-tree", "--no-commit-id", "--name-only", "-r", basis.commit_sha])).split("\n").filter(Boolean).sort();
  if (basisParent !== basis.parent_sha || basisTree !== basis.tree_sha
    || !body.split("\n").includes(`X-Ticket-Tx: ${basis.transaction_id}`)
    || JSON.stringify(changed) !== JSON.stringify([...basis.changed_paths].sort())) throw conflict();
  for (const [path, checksum] of Object.entries(basis.path_checksums)) {
    await rootGit.assertSafePath(path);
    if (sha(await rootGit.fileAt(basis.commit_sha, path)) !== checksum) throw conflict();
  }
  const checksums = Object.fromEntries(paths.map((path) => [path, manifest.entries[path].latest_sha]));
  for (const path of paths) {
    await rootGit.assertSafePath(path);
    const mode = await rootGit.modeAt(commit, path);
    if (mode && !["100644", "100755"].includes(mode)) throw conflict();
    if (sha(await rootGit.fileAt(commit, path)) !== checksums[path]) return null;
  }
  const journal = { task_id: taskId, project_id: projectId, revision: manifest.revision, reconciliation: "inherited_source",
    reconciled_from_revision: basis.revision, reconciled_from_commit_sha: basis.commit_sha,
    commit_sha: commit, tree_sha: (await rootGit.run(["rev-parse", `${commit}^{tree}`])).trim(),
    manifest_sha: manifestSha(manifest), path_checksums: checksums,
    operation_ids: Object.fromEntries(paths.map((path) => [path, manifest.entries[path].operations.map((item) => item.id)])),
    claim_ids: Object.fromEntries(paths.map((path) => [path, manifest.entries[path].claim_id ?? null])), phase: "receipt_persisted" };
  if (existing && Object.entries(journal).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))) throw conflict();
  // Rechecks mutable source at both persistence boundaries without inspecting unrelated dirty files.
  async function assertSource() {
    await rootGit.assertAncestor(commit);
    for (const path of paths) {
      await rootGit.assertSafePath(path);
      if (sha(await readOptional(path)) !== checksums[path]) throw Object.assign(new ConfigurationError(`Inherited ticket source changed: ${path}.`), { code: "TICKET_SOURCE_DRIFT" });
    }
  }
  await assertSource();
  if (!existing) await saveJournal(journal);
  await assertSource();
  await record(manifest.revision, commit);
  projectLogger({ event_name: "ticket.inherited_commit_reconciled", level: "info", status: "success", task_id: taskId, project_id: projectId,
    source: "ticket-inherited-commit", message: "Ticket source already exists in descendant Git history; source reference recorded.",
    payload: { commit_sha: commit, revision: manifest.revision, reconciled_from_revision: basis.revision, path_count: paths.length } });
  return { sha: commit, repeated: true, inherited: true, revision: manifest.revision };
}
