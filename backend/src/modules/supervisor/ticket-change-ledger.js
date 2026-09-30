// Records ticket-owned root writes so watcher indexing and later commits use the same source.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const ROOT = ".forge/runtime/ticket-changes";
// Hashes source snapshots to detect concurrent ticket changes.
const sha = (content) => content === null ? null : `sha256:${createHash("sha256").update(content).digest("hex")}`;
// Maps project and file identifiers to private runtime storage names.
const key = (path) => createHash("sha256").update(path).digest("hex");
// Labels ticket change failures for tool and Supervisor handling.
const failure = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Creates a durable write journal and exclusive file claims for one project.
export function createTicketChangeLedger({ fileService, projectId, projectLogger = () => {} } = {}) {
  if (!fileService?.atomicWrite || !fileService?.createLock || !projectId) throw failure("CONFIGURATION_ERROR", "Ticket change ledger requires File Service and project ID.");
  const scope = `${ROOT}/${key(projectId)}`;
  // Locates durable journal entries for a ticket within this project.
  const manifestPath = (taskId) => `${scope}/tickets/${key(taskId)}.json`;
  // Locates the exclusive claim for a project-relative source path.
  const claimPath = (path) => `${scope}/claims/${key(path)}.json`;
  // Locates a cross-process lock for ticket and path transactions.
  const lockPath = (name) => `${scope}/locks/${key(name)}.lock`;

  // Holds a ticket revision stable while a root commit is prepared and recorded.
  async function withCommitTransaction(taskId, action) {
    return locked(`ticket:${taskId}`, async () => {
      let manifest = await load(taskId);
      for (const [path, entry] of Object.entries(manifest.entries)) {
        if (entry.pending) manifest = await locked(`path:${path}`, () => recover(taskId, path, manifest));
        if (sha(await readOptional(path)) !== manifest.entries[path].latest_sha) throw failure("TICKET_SOURCE_DRIFT", `Root source changed outside ticket ${taskId}: ${path}.`);
      }
      const record = async (revision, commitSha) => {
        if (manifest.revision !== revision) throw failure("TICKET_REVISION_CHANGED", "Ticket changed during root commit.");
        manifest.commits[revision] = commitSha;
        manifest.pending_commit = null;
        await save(taskId, manifest);
      };
      return action(manifest, record);
    });
  }

  // Reads ticket changes without treating a missing manifest as an error.
  async function load(taskId) {
    try { return JSON.parse(await fileService.readFile({ path: manifestPath(taskId) })); }
    catch (error) { if (error.code !== "ENOENT") throw error; return { project_id: projectId, task_id: taskId, state: "active", revision: 0, entries: {}, commits: {}, pending_commit: null }; }
  }

  // Serializes related operations across Control API workers and processes.
  async function locked(name, action) {
    const lock = await acquireTicketFileLock(fileService, lockPath(name));
    try { return await action(); } finally { await lock.release(); }
  }

  // Reads a claim without exposing recorded source text to logs or tool results.
  async function claim(path) {
    try { return JSON.parse(await fileService.readFile({ path: claimPath(path) })); }
    catch (error) { if (error.code !== "ENOENT") throw error; return null; }
  }

  // Finishes a prepared write after restart if the root already has its expected content.
  async function recover(taskId, path, manifest) {
    const pending = manifest.entries[path]?.pending;
    if (!pending) return manifest;
    const live = await readOptional(path);
    if (sha(live) === pending.after_sha) {
      manifest.entries[path].operations.push({ ...pending, revision: manifest.revision + 1, status: "completed" });
      manifest.entries[path].latest_sha = pending.after_sha;
      manifest.entries[path].pending = null;
      manifest.revision += 1;
      await save(taskId, manifest);
      return manifest;
    }
    if (sha(live) !== pending.before_sha) throw failure("TICKET_WRITE_RECOVERY_CONFLICT", `Root source changed while recovering ${path}.`);
    manifest.entries[path].pending = null;
    await save(taskId, manifest);
    return manifest;
  }

  // Claims a discovered path and atomically journals one Forge write to the project root.
  async function write({ taskId, path, before, after, operationId } = {}) {
    if (!taskId || !path || (typeof after !== "string" && after !== null) || (after === null && typeof before !== "string")) throw failure("TICKET_WRITE_INVALID", "Ticket write requires task, path, and content or an existing file to delete.");
    const id = operationId ?? key(`${taskId}\0${path}\0${sha(before)}\0${sha(after)}`);
    return locked(`ticket:${taskId}`, () => locked(`path:${path}`, async () => {
      const owned = await claim(path);
      if (owned?.task_id !== undefined && owned.task_id !== taskId) throw failure("FILE_CLAIM_CONFLICT", `${path} is owned by ticket ${owned.task_id}.`);
      let manifest = await load(taskId);
      if (manifest.state === "closed") throw failure("TICKET_CHANGE_CLOSED", `Ticket ${taskId} has already integrated its changes.`);
      manifest = await recover(taskId, path, manifest);
      const existing = manifest.entries[path];
      const repeated = existing?.operations.find((item) => item.id === id);
      if (repeated) {
        if (repeated.after_sha !== sha(after)) throw failure("TICKET_OPERATION_CONFLICT", `Ticket write ID was reused for different content: ${path}.`);
        return { path, sha256: repeated.after_sha, repeated: true };
      }
      const live = await readOptional(path);
      if (sha(live) !== sha(before)) throw failure("CHECKSUM_MISMATCH", `Root source changed before writing ${path}.`);
      if (existing && existing.latest_sha !== sha(live)) throw failure("TICKET_SOURCE_CHANGED", `Root source changed outside ticket ${taskId}: ${path}.`);
      if (!owned) await fileService.atomicWrite({ path: claimPath(path), content: JSON.stringify({ task_id: taskId, path }), replace: false });
      const entry = existing ?? { path, initial_sha: sha(before), initial_content: before, latest_sha: sha(before), operations: [], pending: null };
      const operation = { id, before_sha: sha(before), after_sha: sha(after), before, after };
      entry.pending = operation;
      manifest.entries[path] = entry;
      await save(taskId, manifest);
      try { if (after === null) await fileService.deleteFile({ path }); else await fileService.atomicWrite({ path, content: after, replace: true }); }
      catch (error) { projectLogger({ event_name: "ticket.change_write_failed", level: "error", status: "failed", message: "Ticket root write failed.", task_id: taskId, source: "ticket-change-ledger", error_code: error.code ?? "FILE_WRITE_FAILED", payload: { path } }); throw error; }
      entry.operations.push({ ...operation, revision: manifest.revision + 1, status: "completed" });
      entry.pending = null;
      entry.latest_sha = sha(after);
      manifest.revision += 1;
      await save(taskId, manifest);
      projectLogger({ event_name: "ticket.change_written", level: "info", status: "success", message: "Ticket changed project source.", task_id: taskId, source: "ticket-change-ledger", payload: { path, revision: manifest.revision, sha256: entry.latest_sha } });
      return { path, sha256: entry.latest_sha, revision: manifest.revision };
    }));
  }

  // Loads and validates the current ticket snapshot for a worktree commit.
  async function snapshot(taskId) {
    return locked(`ticket:${taskId}`, async () => {
      let manifest = await load(taskId);
      for (const [path, entry] of Object.entries(manifest.entries)) {
        if (entry.pending) manifest = await locked(`path:${path}`, () => recover(taskId, path, manifest));
        if (sha(await readOptional(path)) !== entry.latest_sha) throw failure("TICKET_SOURCE_CHANGED", `Root source changed outside ticket ${taskId}: ${path}.`);
      }
      return manifest;
    });
  }

  // Journals the worktree HEAD before Git creates a ticket commit.
  async function prepareCommit(taskId, revision, baseHead) {
    return locked(`ticket:${taskId}`, async () => {
      const manifest = await load(taskId);
      if (manifest.revision !== revision) throw failure("TICKET_REVISION_CHANGED", "Ticket changed during commit preparation.");
      if (manifest.pending_commit && (manifest.pending_commit.revision !== revision || manifest.pending_commit.base_head !== baseHead)) throw failure("TICKET_COMMIT_PENDING", "A different ticket commit is already pending.");
      manifest.pending_commit = { revision, base_head: baseHead };
      await save(taskId, manifest);
      return manifest.pending_commit;
    });
  }

  // Persists the successful commit and clears its recovery marker.
  async function recordCommit(taskId, revision, commitSha) {
    return locked(`ticket:${taskId}`, async () => {
      const manifest = await load(taskId);
      if (manifest.revision !== revision) throw failure("TICKET_REVISION_CHANGED", "Ticket changed during commit.");
      manifest.commits[revision] = commitSha;
      manifest.pending_commit = null;
      await save(taskId, manifest);
      return manifest;
    });
  }

  // Imports a verified legacy ticket snapshot without replaying its existing commits.
  async function importLegacy(taskId, { baseCommit, headCommit, entries }) {
    return locked(`ticket:${taskId}`, async () => {
      const manifest = await load(taskId);
      if (manifest.legacy?.head_commit === headCommit) return manifest;
      if (manifest.revision || Object.keys(manifest.entries).length || Object.keys(manifest.commits).length) throw failure("TICKET_MIGRATION_CONFLICT", "Ticket already has a change ledger.");
      const paths = Object.keys(entries).sort();
      if (!paths.length) throw failure("TICKET_MIGRATION_CONFLICT", "Legacy worktree has no source changes to import.");
      for (const path of paths) {
        const owned = await claim(path);
        if (owned?.task_id && owned.task_id !== taskId) throw failure("FILE_CLAIM_CONFLICT", `${path} is owned by ticket ${owned.task_id}.`);
        if (sha(await readOptional(path)) !== sha(entries[path].root)) throw failure("TICKET_SOURCE_CHANGED", `Root source changed during migration: ${path}.`);
      }
      for (const path of paths) await locked(`path:${path}`, async () => {
        const owned = await claim(path);
        if (owned?.task_id && owned.task_id !== taskId) throw failure("FILE_CLAIM_CONFLICT", `${path} is owned by ticket ${owned.task_id}.`);
        if (sha(await readOptional(path)) !== sha(entries[path].root)) throw failure("TICKET_SOURCE_CHANGED", `Root source changed during migration: ${path}.`);
        if (!owned) await fileService.atomicWrite({ path: claimPath(path), content: JSON.stringify({ task_id: taskId, path }), replace: false });
      });
      const imported = { ...manifest, revision: 0, entries: {}, commits: { 0: headCommit }, legacy: { base_commit: baseCommit, head_commit: headCommit }, pending_commit: null };
      for (const path of paths) {
        const { committed, root } = entries[path];
        imported.entries[path] = { path, initial_sha: sha(committed), initial_content: committed, latest_sha: sha(root), operations: [], pending: null };
        if (committed !== root) {
          imported.revision += 1;
          imported.entries[path].operations.push({ id: key(`legacy\0${taskId}\0${path}\0${sha(root)}`), before_sha: sha(committed), after_sha: sha(root), before: committed, after: root, revision: imported.revision, status: "completed" });
        }
      }
      await save(taskId, imported);
      projectLogger({ event_name: "ticket.change_migrated", level: "info", status: "success", message: "Legacy ticket changes imported into ledger.", task_id: taskId, source: "ticket-change-ledger", payload: { path_count: paths.length, pending_count: imported.revision, head_commit: headCommit } });
      return imported;
    });
  }

  // Releases file claims only after a ticket has reached an explicit terminal decision.
  async function release(taskId) {
    return locked(`ticket:${taskId}`, async () => {
      const manifest = await load(taskId);
      if (manifest.state === "closed") return Object.keys(manifest.entries);
      for (const path of Object.keys(manifest.entries)) await locked(`path:${path}`, async () => {
        const current = await claim(path);
        if (current?.task_id === taskId) await fileService.deleteFile({ path: claimPath(path) });
      });
      manifest.state = "closed";
      await save(taskId, manifest);
      return Object.keys(manifest.entries);
    });
  }

  // Reads an existing root file while preserving the absent-file baseline.
  async function readOptional(path) {
    try { return await fileService.readFile({ path }); }
    catch (error) { if (error.code !== "ENOENT") throw error; return null; }
  }
  // Persists the ticket manifest after an ownership or revision transition.
  async function save(taskId, manifest) { await fileService.atomicWrite({ path: manifestPath(taskId), content: JSON.stringify(manifest), replace: true }); }
  return Object.freeze({ load, write, snapshot, prepareCommit, recordCommit, importLegacy, release, withCommitTransaction });
}
