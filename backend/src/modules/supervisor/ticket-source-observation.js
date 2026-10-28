/** Records live source drift as implementation context for the assigned agent.
 * Observation never edits project files, adopts external changes as ticket work,
 * grants approval, or decides whether concurrent edits are semantically valid. */
// Defines createTicketSourceObservation function behavior for ticket-source-observation.js.
export function createTicketSourceObservation({ locked, load, save, recover, readOptional, sha, projectLogger }) {
  /** Reads tracked paths under journal locks so Coder can resume on current source
   * while commit and write services retain their independent consistency checks. */
  return async function observe(taskId) {
    return locked(`ticket:${taskId}`, async () => {
      let manifest = await load(taskId);
      if (manifest.state === "closed") return manifest;
      for (const path of Object.keys(manifest.entries)) await locked(`path:${path}`, async () => {
        manifest = await recover(taskId, path, manifest);
        const entry = manifest.entries[path];
        const liveSha = sha(await readOptional(path));
        const prior = entry.source_reconciliation;
        if (liveSha === entry.latest_sha) {
          if (["changed", "conflict"].includes(prior?.status)) {
            entry.source_reconciliation = { ...prior, status: "unchanged", ticket_sha: entry.latest_sha, live_sha: liveSha };
            await save(taskId, manifest);
          }
          return;
        }
        if (["changed", "conflict"].includes(prior?.status) && prior.ticket_sha === entry.latest_sha && prior.live_sha === liveSha) return;
        entry.source_reconciliation = { status: "changed", base_sha: entry.initial_sha, ticket_sha: entry.latest_sha, live_sha: liveSha };
        await save(taskId, manifest);
        projectLogger({ event_name: "ticket.source_changed", level: "info", status: "info", task_id: taskId,
          source: "ticket-source-observation", message: "Live source changed; Coder must read the current file before editing. Checkpoint and ticket writes preserved.",
          payload: { path, ...entry.source_reconciliation } });
      });
      return manifest;
    });
  };
}

/** Supplies bounded, source-bound facts to Coder without exposing journal file
 * contents or presenting an observed external edit as approved implementation. */
export function ticketSourceChanges(manifest) {
  return Object.entries(manifest?.entries ?? {}).filter(([, entry]) => ["changed", "conflict"].includes(entry.source_reconciliation?.status))
    .map(([path, entry]) => ({ path, recorded_sha256: entry.latest_sha, current_sha256: entry.source_reconciliation.live_sha }));
}

/** Gives every provider the same source-refresh assignment: agents judge code,
 * while Forge enforces scope, ownership and fresh checksums at the actual write. */
export function ticketSourceChangesPrompt(changes) {
  if (!changes?.length) return "";
  return `CURRENT SOURCE CHANGES: ${JSON.stringify(changes)}\nContinue from your retained checkpoint and settled SL/AM decisions. These hashes describe source changes, not an approval denial or a finding. Read each affected current file with read_file/read_lines, assess it against the ticket, preserve concurrent work and implement only the remaining change. Use its fresh whole-file checksum when writing. If a tracked file needs no further edit, explicitly retain its current version with edit_diff using an identical exact anchor/replacement and the fresh checksum; Node records your source resolution without changing its bytes. Do not restore old snapshots or request Owner/AM approval merely because a checksum changed. Consult SL only for a concrete unresolved implementation or scope question. Commit and verification still require recorded ticket writes and exact committed evidence.\n`;
}
