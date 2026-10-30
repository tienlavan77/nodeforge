// Imports retained legacy ticket evidence without replaying commits or changing file ownership rules.

// Binds legacy import to the same ticket locks and persistence contracts as normal root writes.
export function createTicketLegacyImport({ locked, load, failure, claim, sha, readOptional, fileService, claimPath, save, key, projectLogger }) {
  // Imports a verified legacy ticket snapshot without replaying its existing commits.
  return async function importLegacy(taskId, { baseCommit, headCommit, entries }) {
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
  };
}
