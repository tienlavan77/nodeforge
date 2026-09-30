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
  return Object.freeze({ rootOnly: true, commit, status: gitService.status, diffWorkingTree: gitService.diffWorkingTree, diffPatchFrom,
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

  // Validates root bytes and either recovers or creates the commit for one ledger revision.
  async function commitLocked(message, requestedPaths, manifest, record) {
    const expected = Object.keys(manifest.entries).sort();
    if (!expected.length || requestedPaths.some((path) => !expected.includes(path))) throw fail("TICKET_COMMIT_SCOPE", "Requested commit paths are outside the ticket ledger.");
    const revision = manifest.revision;
    const existing = manifest.commits[revision];
    if (existing) {
      const saved = await loadJournal(revision);
      if (!saved || saved.commit_sha !== existing) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Ticket commit receipt lacks a matching transaction journal.");
      if (saved.phase !== "receipt_persisted") await recover(saved, manifest, record);
      else await rootGit.assertAncestor(existing);
      return { sha: existing, repeated: true };
    }
    const lastCommitted = Math.max(0, ...Object.keys(manifest.commits).map(Number));
    const changed = expected.filter((path) => manifest.entries[path].operations.some((item) => item.revision > lastCommitted));
    if (!changed.length) throw fail("GIT_EMPTY_COMMIT", "Ticket has no uncommitted ledger operations.");
    let journal = await loadJournal(revision);
    if (journal) {
      if (journal.phase === "receipt_persisted") throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Transaction receipt exists without a matching ledger commit.");
      return recover(journal, manifest, record);
    }
    const parent = (await gitService.getHead()).trim();
    const branch = await rootGit.checkedBranch();
    if (expectedBranch && branch !== `refs/heads/${expectedBranch}`) throw fail("TICKET_ROOT_BRANCH_CHANGED", "Ticket root branch differs from the persisted workspace branch.");
    if ((await rootGit.run(["diff", "--cached", "--name-only"])).trim()) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", "Shared Git index contains staged changes.");
    const indexSha = await rootGit.indexIdentity();
    for (const path of expected) {
      const entry = manifest.entries[path];
      const current = await readOptional(path);
      if (sha(current) !== entry.latest_sha) throw fail("TICKET_SOURCE_DRIFT", `Root source differs from the ticket ledger: ${path}.`);
      if (!changed.includes(path)) continue;
      const pending = entry.operations.filter((item) => item.revision > lastCommitted).sort((a, b) => a.revision - b.revision);
      const parentContent = await rootGit.fileAt(parent, path);
      if (sha(parentContent) !== pending[0].before_sha) throw fail("TICKET_BASELINE_CONFLICT", `Ticket before-state differs from parent commit: ${path}.`);
    }
    const pathChecksums = Object.fromEntries(expected.map((path) => [path, manifest.entries[path].latest_sha]));
    journal = { task_id: taskId, project_id: projectId, transaction_id: randomUUID(), revision, parent_sha: parent, branch, index_sha: indexSha, manifest_sha: manifestSha(manifest), path_checksums: pathChecksums, changed_paths: changed, phase: "prepared" };
    await saveJournal(journal);
    const directory = await mkdtemp(join(tmpdir(), "nodeforge-ticket-index-"));
    try {
      const tree = await rootGit.buildTree(parent, changed, join(directory, "index"));
      await rootGit.verifyTree(parent, tree, manifest.entries, changed);
      journal = await saveJournal({ ...journal, tree_sha: tree });
      if (await rootGit.indexIdentity() !== indexSha || (await gitService.getHead()).trim() !== parent || await rootGit.checkedBranch() !== branch) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", "Root index or branch moved during commit preparation.");
      const commitMessage = `${message.trim()}\n\nX-Ticket-Tx: ${journal.transaction_id}`;
      const commitSha = (await rootGit.run(["commit-tree", tree, "-p", parent, "-m", commitMessage])).trim();
      journal = await saveJournal({ ...journal, commit_sha: commitSha, phase: "commit_object_created" });
      await rootGit.run(["update-ref", branch, commitSha, parent]);
      journal = await saveJournal({ ...journal, phase: "branch_ref_advanced" });
      await synchronize(journal);
      await record(revision, commitSha);
      await saveJournal({ ...journal, phase: "receipt_persisted" });
      projectLogger({ event_name: "ticket.root_commit_completed", level: "info", status: "success", message: "Ticket root commit recorded.", task_id: taskId, source: "ticket-root-commit-service", payload: { commit_sha: commitSha, transaction_id: journal.transaction_id, path_count: changed.length } });
      return { sha: commitSha, tree_sha: tree, transaction_id: journal.transaction_id };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  // Restores a matching transaction after a Control API crash without making another commit.
  async function recover(journal, manifest, record) {
    if (journal.task_id !== taskId || journal.project_id !== projectId || journal.revision !== manifest.revision) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared root commit does not match the ticket ledger.");
    if (!journal.commit_sha) {
      if (!journal.tree_sha) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared root commit has no candidate tree; explicit inspection is required before retry.");
      const discovered = await rootGit.findTransactionCommit({ transactionId: journal.transaction_id, parent: journal.parent_sha, tree: journal.tree_sha });
      if (!discovered) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Prepared root commit has no matching transaction object; explicit inspection is required before retry.");
      return recover(await saveJournal({ ...journal, commit_sha: discovered, phase: "commit_object_created" }), manifest, record);
    }
    const parent = (await rootGit.run(["rev-list", "--parents", "-n", "1", journal.commit_sha])).trim().split(/\s+/)[1];
    const tree = (await rootGit.run(["rev-parse", `${journal.commit_sha}^{tree}`])).trim();
    const body = await rootGit.run(["log", "-1", "--format=%B", journal.commit_sha]);
    if (parent !== journal.parent_sha || tree !== journal.tree_sha || !body.split("\n").some((line) => line === `X-Ticket-Tx: ${journal.transaction_id}`) || journal.manifest_sha !== manifestSha(manifest) || JSON.stringify(journal.path_checksums) !== JSON.stringify(Object.fromEntries(Object.keys(manifest.entries).sort().map((path) => [path, manifest.entries[path].latest_sha])))) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Root commit identity differs from the prepared ticket transaction.");
    const committedPaths = (await rootGit.run(["diff-tree", "--no-commit-id", "--name-only", "-r", journal.commit_sha])).split("\n").filter(Boolean).sort();
    if (JSON.stringify(committedPaths) !== JSON.stringify([...journal.changed_paths].sort())) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Recovered root commit includes paths outside its ticket manifest.");
    await rootGit.verifyTree(journal.parent_sha, journal.tree_sha, manifest.entries, journal.changed_paths);
    const head = (await gitService.getHead()).trim();
    if (head === journal.parent_sha) {
      if (await rootGit.checkedBranch() !== journal.branch) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Checked-out root branch changed during ticket recovery.");
      await rootGit.run(["update-ref", journal.branch, journal.commit_sha, journal.parent_sha]);
    }
    else await rootGit.assertAncestor(journal.commit_sha);
    await synchronize(journal);
    await record(journal.revision, journal.commit_sha);
    await saveJournal({ ...journal, phase: "receipt_persisted" });
    return { sha: journal.commit_sha, tree_sha: journal.tree_sha, transaction_id: journal.transaction_id, recovered: true };
  }

  // Advances the shared index only if no other actor changed its pre-commit state.
  async function synchronize(journal) {
    const current = await rootGit.indexIdentity();
    if (current !== journal.index_sha) {
      const indexTree = (await rootGit.run(["write-tree"])).trim();
      if (indexTree !== journal.tree_sha) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", "Shared Git index changed after ticket commit; transaction quarantined.");
      return;
    }
    if ((await gitService.getHead()).trim() !== journal.commit_sha) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", "Root branch advanced before shared-index synchronization; transaction quarantined.");
    await rootGit.run(["read-tree", journal.commit_sha]);
    await saveJournal({ ...journal, phase: "shared_index_synchronized" });
  }

  // Loads a transaction record without treating a missing journal as an empty commit.
  async function loadJournal(revision) {
    try { return JSON.parse(await fileService.readFile({ path: journalPath(revision) })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Persists each phase before a subsequent irreversible Git step.
  async function saveJournal(value) {
    await fileService.atomicWrite({ path: journalPath(value.revision), content: `${JSON.stringify(value)}\n`, replace: true });
    return value;
  }

  // Reads a root source file while preserving deleted-file identity.
  async function readOptional(path) {
    try { return await fileService.readFile({ path }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
}
