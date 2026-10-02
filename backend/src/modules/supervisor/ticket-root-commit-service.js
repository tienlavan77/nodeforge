// Commits only durable ticket changes from the project root with crash-recoverable Git provenance.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { createTicketRootGit } from "./ticket-root-git.js";
import { withTicketProjectCommitLock } from "./ticket-project-commit-lock.js";

const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
const sha = (value) => value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
const key = (value) => createHash("sha256").update(value).digest("hex");
const manifestSha = (manifest) => sha(JSON.stringify(Object.keys(manifest.entries).sort().map((path) => ({ path, before_sha: manifest.entries[path].initial_sha ?? null, after_sha: manifest.entries[path].latest_sha ?? null }))));

// Creates one root commit tool with private staging and a durable transaction journal.
export function createTicketRootCommitService({ taskId, projectId, projectRoot, fileService, ledger, gitService, expectedBranch, projectLogger = () => {} } = {}) {
  if (!taskId || !projectId || !projectRoot || !fileService?.atomicWrite || !ledger?.withCommitTransaction || !gitService?.getHead) throw fail("CONFIGURATION_ERROR", "Root commit service needs ticket, File Service, ledger, and Git.");
  const rootGit = createTicketRootGit({ projectRoot });
  const journalPath = (revision) => `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${revision}.json`;
  const dispositionPath = (revision) => `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${revision}-disposition.json`;
  const retryPath = (revision) => `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${revision}-retry.json`;
  return Object.freeze({ rootOnly: true, commit, reconcileNoRefMove, status: gitService.status, diffWorkingTree: gitService.diffWorkingTree, diffPatchFrom,
    getHead: gitService.getHead, getCommitParent: gitService.getCommitParent, getChangedFiles: gitService.getChangedFiles, getCommitsForTask, assertAncestor: rootGit.assertAncestor });

  // Reports only commits proven by this ticket's durable ledger receipts.
  async function getCommitsForTask(requestedTaskId) {
    if (requestedTaskId !== taskId) throw fail("TICKET_COMMIT_SCOPE", "Commit report belongs to another ticket.");
    const manifest = await ledger.load(taskId);
    const commits = [];
    for (const commitSha of [...new Set(Object.values(manifest.commits))]) {
      await rootGit.assertAncestor(commitSha);
      const subject = (await rootGit.run(["show", "-s", "--format=%s", commitSha])).trim();
      commits.push({ sha: commitSha, subject });
    }
    return commits;
  }

  // Reads only the ticket's committed patch, excluding later commits and dirty root bytes.
  async function diffPatchFrom(base, { paths = [] } = {}) {
    const manifest = await ledger.load(taskId);
    const commitSha = manifest.commits[manifest.revision];
    if (!commitSha || !/^[a-f0-9]{40,64}$/i.test(base ?? "") || !paths.length) throw fail("REVIEW_COMMIT_MISSING", "Committed ticket patch needs its base and manifest paths.");
    const parent = await gitService.getCommitParent(commitSha);
    await rootGit.assertAncestor(base);
    return rootGit.run(["diff", "--no-ext-diff", "--unified=3", parent, commitSha, "--", ...paths.map((path) => `:(literal)${path}`)]);
  }

  // Serializes root commits, then holds the ticket ledger revision until its receipt is saved.
  async function commit(message, { paths = [] } = {}) {
    if (typeof message !== "string" || !message.trim()) throw fail("GIT_COMMIT_MESSAGE_INVALID", "Ticket commit message is required.");
    return withTicketProjectCommitLock({ fileService, projectId }, () => ledger.withCommitTransaction(taskId, (manifest, record) => commitLocked(message, paths, manifest, record)));
  }

  // Opens a same-ticket retry only when a pre-tree transaction could not have advanced Git.
  async function reconcileNoRefMove() {
    return withTicketProjectCommitLock({ fileService, projectId }, () => ledger.withCommitTransaction(taskId, async (manifest) => {
      const revision = manifest.revision;
      const original = await readOptionalState(journalPath(revision));
      if (!original) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "No original ticket transaction exists to reconcile.");
      const journal = JSON.parse(original);
      const existing = await readOptionalState(dispositionPath(revision));
      if (existing) {
        const record = JSON.parse(existing);
        if (record.original_sha === sha(original) && record.transaction_id === journal.transaction_id && record.disposition === "reconciled_no_ref_move") return record;
        throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Ticket retry disposition differs from its original journal.");
      }
      const head = (await gitService.getHead()).trim();
      const branch = await rootGit.checkedBranch();
      const checksums = Object.fromEntries(Object.keys(manifest.entries).sort().map((path) => [path, manifest.entries[path].latest_sha]));
      if (journal.task_id !== taskId || journal.project_id !== projectId || journal.revision !== revision || journal.phase !== "prepared"
        || journal.tree_sha || journal.commit_sha || manifest.commits[revision] || manifest.pending_commit
        || journal.parent_sha !== head || journal.branch !== branch || journal.manifest_sha !== manifestSha(manifest)
        || JSON.stringify(journal.path_checksums) !== JSON.stringify(checksums)) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared transaction cannot be proven safe for a same-ticket retry.");
      const record = { task_id: taskId, project_id: projectId, revision, transaction_id: journal.transaction_id, original_sha: sha(original), parent_sha: head, branch, manifest_sha: journal.manifest_sha, disposition: "reconciled_no_ref_move", reason: "prepared_before_candidate_tree", recorded_at: new Date().toISOString() };
      await fileService.atomicWrite({ path: dispositionPath(revision), content: `${JSON.stringify(record)}\n`, replace: false });
      return record;
    }));
  }

  // Validates root bytes and either recovers or creates the commit for one ledger revision.
  async function commitLocked(message, requestedPaths, manifest, record) {
    const expected = Object.keys(manifest.entries).sort();
    if (!expected.length || requestedPaths.some((path) => !expected.includes(path))) throw fail("TICKET_COMMIT_SCOPE", "Requested commit paths are outside the ticket ledger.");
    const revision = manifest.revision;
    const existing = manifest.commits[revision];
    if (existing) {
      const saved = await loadJournal(revision);
      if (!saved || saved.commit_sha !== existing) {
        if (saved) await auditQuarantine(saved, "receipt_journal_mismatch");
        throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Ticket commit receipt lacks a matching transaction journal.");
      }
      if (saved.phase !== "receipt_persisted") await recover(saved, manifest, record);
      else await rootGit.assertAncestor(existing);
      return { sha: existing, repeated: true };
    }
    const lastCommitted = Math.max(0, ...Object.keys(manifest.commits).map(Number));
    const changed = expected.filter((path) => manifest.entries[path].operations.some((item) => item.revision > lastCommitted));
    if (!changed.length) throw fail("GIT_EMPTY_COMMIT", "Ticket has no uncommitted ledger operations.");
    let journal = await loadJournal(revision);
    if (journal) {
      if (journal.phase === "receipt_persisted") {
        await auditQuarantine(journal, "ledger_receipt_missing");
        throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Transaction receipt exists without a matching ledger commit.");
      }
      return recover(journal, manifest, record);
    }
    const parent = (await gitService.getHead()).trim();
    const branch = await rootGit.checkedBranch();
    if (expectedBranch && branch !== `refs/heads/${expectedBranch}`) throw fail("TICKET_ROOT_BRANCH_CHANGED", "Ticket root branch differs from the persisted workspace branch.");
    for (const path of expected) {
      await rootGit.assertSafePath(path);
      const entry = manifest.entries[path];
      const current = await readOptional(path);
      if (sha(current) !== entry.latest_sha) throw fail("TICKET_SOURCE_DRIFT", `Root source differs from the ticket ledger: ${path}.`);
      if (!changed.includes(path)) continue;
      const pending = entry.operations.filter((item) => item.revision > lastCommitted).sort((a, b) => a.revision - b.revision);
      const parentContent = await rootGit.fileAt(parent, path);
      if (sha(parentContent) === entry.latest_sha) { changed.splice(changed.indexOf(path), 1); continue; }
      if (sha(parentContent) !== pending[0].before_sha) throw fail("TICKET_BASELINE_CONFLICT", `Ticket before-state differs from parent commit: ${path}.`);
    }
    if (!changed.length) throw fail("GIT_EMPTY_COMMIT", "Ticket operations have no net change against the parent commit.");
    const pathChecksums = Object.fromEntries(expected.map((path) => [path, manifest.entries[path].latest_sha]));
    const claimIds = Object.fromEntries(expected.map((path) => [path, manifest.entries[path].claim_id ?? null]));
    const operationIds = Object.fromEntries(expected.map((path) => [path, manifest.entries[path].operations.map((item) => item.id)]));
    journal = { task_id: taskId, project_id: projectId, transaction_id: randomUUID(), revision, parent_sha: parent, branch, manifest_sha: manifestSha(manifest), path_checksums: pathChecksums, claim_ids: claimIds, operation_ids: operationIds, changed_paths: changed, phase: "prepared" };
    await saveJournal(journal);
    const directory = await mkdtemp(join(tmpdir(), "nodeforge-ticket-index-"));
    try {
      const tree = await rootGit.buildTree(parent, changed, join(directory, "index"));
      await rootGit.verifyTree(parent, tree, manifest.entries, changed);
      journal = await saveJournal({ ...journal, tree_sha: tree });
      for (const path of expected) {
        await rootGit.assertSafePath(path);
        if (sha(await readOptional(path)) !== manifest.entries[path].latest_sha) throw fail("TICKET_SOURCE_DRIFT", `Root source changed during ticket commit: ${path}.`);
      }
      if ((await gitService.getHead()).trim() !== parent || await rootGit.checkedBranch() !== branch) throw fail("TICKET_REF_CONFLICT", "Root branch moved during ticket commit preparation.");
      const commitMessage = `${message.trim()}\n\nX-Ticket-Tx: ${journal.transaction_id}`;
      const commitSha = (await rootGit.run(["commit-tree", tree, "-p", parent, "-m", commitMessage])).trim();
      journal = await saveJournal({ ...journal, commit_sha: commitSha, phase: "commit_object_created" });
      try { await rootGit.run(["update-ref", branch, commitSha, parent]); }
      catch (error) { throw fail("TICKET_REF_CONFLICT", `Root branch compare-and-swap failed: ${error.message}`); }
      journal = await saveJournal({ ...journal, phase: "branch_ref_advanced" });
      await record(revision, commitSha);
      await saveJournal({ ...journal, phase: "receipt_persisted" });
      projectLogger({ event_name: "ticket.root_commit_completed", level: "info", status: "success", message: "Ticket root commit recorded.", task_id: taskId, source: "ticket-root-commit-service", payload: { commit_sha: commitSha, transaction_id: journal.transaction_id, path_count: changed.length } });
      return { sha: commitSha, tree_sha: tree, transaction_id: journal.transaction_id };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  // Restores a matching transaction after a Control API crash without making another commit.
  async function recover(journal, manifest, record) {
    if (journal.task_id !== taskId || journal.project_id !== projectId || journal.revision !== manifest.revision
      || (journal.claim_ids && JSON.stringify(journal.claim_ids) !== JSON.stringify(Object.fromEntries(Object.keys(manifest.entries).sort().map((path) => [path, manifest.entries[path].claim_id ?? null]))))
      || (journal.operation_ids && JSON.stringify(journal.operation_ids) !== JSON.stringify(Object.fromEntries(Object.keys(manifest.entries).sort().map((path) => [path, manifest.entries[path].operations.map((item) => item.id)]))))) {
      await auditQuarantine(journal, "ledger_identity_mismatch");
      throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared root commit does not match the ticket ledger.");
    }
    if (!journal.commit_sha) {
      if (!journal.tree_sha) {
        await auditQuarantine(journal, "candidate_tree_missing");
        throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared root commit has no candidate tree; explicit inspection is required before retry.");
      }
      const discovered = await rootGit.findTransactionCommit({ transactionId: journal.transaction_id, parent: journal.parent_sha, tree: journal.tree_sha });
      if (!discovered) {
        await auditQuarantine(journal, "transaction_object_missing");
        throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared root commit has no matching transaction object; explicit inspection is required before retry.");
      }
      return recover(await saveJournal({ ...journal, commit_sha: discovered, phase: "commit_object_created" }), manifest, record);
    }
    const parent = (await rootGit.run(["rev-list", "--parents", "-n", "1", journal.commit_sha])).trim().split(/\s+/)[1];
    const tree = (await rootGit.run(["rev-parse", `${journal.commit_sha}^{tree}`])).trim();
    const body = await rootGit.run(["log", "-1", "--format=%B", journal.commit_sha]);
    if (parent !== journal.parent_sha || tree !== journal.tree_sha || !body.split("\n").some((line) => line === `X-Ticket-Tx: ${journal.transaction_id}`) || journal.manifest_sha !== manifestSha(manifest) || JSON.stringify(journal.path_checksums) !== JSON.stringify(Object.fromEntries(Object.keys(manifest.entries).sort().map((path) => [path, manifest.entries[path].latest_sha])))) {
      await auditQuarantine(journal, "commit_identity_mismatch");
      throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Root commit identity differs from the prepared ticket transaction.");
    }
    const committedPaths = (await rootGit.run(["diff-tree", "--no-commit-id", "--name-only", "-r", journal.commit_sha])).split("\n").filter(Boolean).sort();
    if (JSON.stringify(committedPaths) !== JSON.stringify([...journal.changed_paths].sort())) {
      await auditQuarantine(journal, "committed_paths_mismatch");
      throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Recovered root commit includes paths outside its ticket manifest.");
    }
    await rootGit.verifyTree(journal.parent_sha, journal.tree_sha, manifest.entries, journal.changed_paths);
    const head = (await gitService.getHead()).trim();
    if (head === journal.parent_sha) {
      if (await rootGit.checkedBranch() !== journal.branch) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Checked-out root branch changed during ticket recovery.");
      await rootGit.run(["update-ref", journal.branch, journal.commit_sha, journal.parent_sha]);
    }
    else {
      try { await rootGit.assertAncestor(journal.commit_sha); }
      catch (error) {
        if (error.code !== "TICKET_COMMIT_UNREACHABLE") throw error;
        await auditQuarantine(journal, "commit_not_reachable_after_ref_move");
        throw fail("TICKET_REF_CONFLICT", "Ticket commit was not integrated into the moved root branch.");
      }
    }
    await record(journal.revision, journal.commit_sha);
    await saveJournal({ ...journal, phase: "receipt_persisted" });
    return { sha: journal.commit_sha, tree_sha: journal.tree_sha, transaction_id: journal.transaction_id, recovered: true };
  }

  // Saves an immutable audit record while leaving the original incomplete transaction untouched.
  async function auditQuarantine(journal, reason) {
    const path = `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${journal.revision}-${key(String(journal.transaction_id ?? "missing"))}-${key(reason)}-quarantine.json`;
    const record = { task_id: taskId, project_id: projectId, transaction_id: journal.transaction_id ?? null, revision: journal.revision, phase: journal.phase, parent_sha: journal.parent_sha, tree_sha: journal.tree_sha ?? null, commit_sha: journal.commit_sha ?? null, manifest_sha: journal.manifest_sha, disposition: "quarantined", reason, actor: "ticket-root-commit-service", recorded_at: new Date().toISOString() };
    try { await fileService.atomicWrite({ path, content: `${JSON.stringify(record)}\n`, replace: false }); }
    catch (error) { if (error.code !== "FILE_ALREADY_EXISTS") throw error; }
    projectLogger({ event_name: "ticket.root_commit_quarantined", level: "error", status: "failed", message: "Incomplete ticket commit transaction requires review.", task_id: taskId, source: "ticket-root-commit-service", error_code: "TICKET_COMMIT_RECOVERY_CONFLICT", payload: { transaction_id: journal.transaction_id, revision: journal.revision, reason } });
  }

  // Loads a transaction record without treating a missing journal as an empty commit.
  async function loadJournal(revision) {
    try { return JSON.parse(await fileService.readFile({ path: await activeJournalPath(revision) })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Keeps the original journal immutable and selects a separate path for an authorized retry.
  async function activeJournalPath(revision) {
    const disposition = await readOptionalState(dispositionPath(revision));
    if (!disposition) return journalPath(revision);
    const original = await readOptionalState(journalPath(revision));
    const record = JSON.parse(disposition);
    if (!original || record.disposition !== "reconciled_no_ref_move" || record.original_sha !== sha(original)) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Ticket retry disposition lost its original journal identity.");
    return retryPath(revision);
  }

  // Reads optional runtime evidence without changing its contents.
  async function readOptionalState(path) {
    try { return await fileService.readFile({ path }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Persists each phase before a subsequent irreversible Git step.
  async function saveJournal(value) {
    const next = { ...value, phase_trace: [...(value.phase_trace ?? []), { phase: value.phase, at: new Date().toISOString(), actor: "ticket-root-commit-service", tree_sha: value.tree_sha ?? null, commit_sha: value.commit_sha ?? null }] };
    await fileService.atomicWrite({ path: await activeJournalPath(next.revision), content: `${JSON.stringify(next)}\n`, replace: true });
    projectLogger({ event_name: "ticket.root_commit_phase_saved", level: "info", status: "success", message: "Ticket root commit transaction phase persisted.", task_id: taskId, source: "ticket-root-commit-service", payload: { transaction_id: next.transaction_id, revision: next.revision, phase: next.phase, parent_sha: next.parent_sha, tree_sha: next.tree_sha ?? null, commit_sha: next.commit_sha ?? null } });
    return next;
  }

  // Reads a root source file while preserving deleted-file identity.
  async function readOptional(path) {
    try { return await fileService.readFile({ path }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
}
