// Reconciles concurrent root edits with durable source-bound receipts, preserving the original ticket write journal.
import { planTicketSourceMerge } from "./ticket-source-merge-plan.js";

// Uses the ledger's ticket/path locks and pending-write recovery so reconciliation survives process interruption.
export function createTicketSourceMerge({ locked, load, save, recover, claim, readOptional, fileService, sha, key, failure, projectLogger }) {
  return Object.freeze({ run, resolve });

  // Observes every drifted ticket file and merges only provably independent edits without changing approval or execution state.
  async function run(taskId) {
    return locked(`ticket:${taskId}`, async () => {
      let manifest = await load(taskId);
      if (manifest.state === "closed" || manifest.pending_commit) return manifest;
      for (const path of Object.keys(manifest.entries)) await locked(`path:${path}`, async () => {
        manifest = await recover(taskId, path, manifest);
        const entry = manifest.entries[path];
        const live = await readOptional(path);
        if (sha(live) === entry.latest_sha) return;
        const owner = await claim(path);
        if (owner && owner.task_id !== taskId) throw failure("FILE_CLAIM_CONFLICT", `${path} is owned by ticket ${owner.task_id}.`);
        const last = entry.operations.at(-1);
        if (!last || last.after_sha !== entry.latest_sha || sha(last.after) !== entry.latest_sha || sha(entry.initial_content) !== entry.initial_sha)
          throw failure("TICKET_SOURCE_CHANGED", `Source snapshots are unavailable for ${path}.`);
        if (entry.source_reconciliation?.status === "conflict" && entry.source_reconciliation.live_sha === sha(live)) return;
        const plan = await planTicketSourceMerge({ base: entry.initial_content, ticket: last.after, live });
        const receipt = { status: plan.status, base_sha: entry.initial_sha, ticket_sha: entry.latest_sha,
          live_sha: sha(live), merged_sha: plan.status === "conflict" ? null : sha(plan.content), conflicts: plan.conflicts };
        if (sha(await readOptional(path)) !== receipt.live_sha) throw failure("TICKET_SOURCE_CHANGED", `Source changed during reconciliation: ${path}.`);
        entry.source_reconciliation = receipt;
        if (plan.status === "conflict") {
          (entry.source_reconciliations ??= []).push({ ...receipt, live_content: live });
          await save(taskId, manifest);
          log(taskId, path, receipt);
          return;
        }
        await record(taskId, path, manifest, last.after, live, plan.content, receipt);
        manifest = await recover(taskId, path, manifest);
        log(taskId, path, receipt);
      });
      return manifest;
    });
  }

  // Accepts an explicit Coder edit against the exact conflict version previously observed by Node, never a stale overwrite.
  async function resolve({ taskId, path, manifest, live }) {
    const entry = manifest.entries[path];
    if (manifest.pending_commit) throw failure("TICKET_COMMIT_PENDING", `Ticket commit must finish before writing ${path}.`);
    const receipt = { base_sha: entry.initial_sha, ticket_sha: entry.latest_sha, live_sha: sha(live) };
    const before = entry.operations.at(-1)?.after;
    if (sha(before) !== entry.latest_sha) throw failure("TICKET_SOURCE_CHANGED", `Recorded source is unavailable for ${path}.`);
    await record(taskId, path, manifest, before, live, live, { ...receipt, status: "coder_resolution", merged_sha: sha(live) });
    await recover(taskId, path, manifest);
    log(taskId, path, entry.source_reconciliation);
  }

  // Persists the reconciliation intent before writing; normal ledger recovery completes its immutable operation after a crash.
  async function record(taskId, path, manifest, before, live, after, receipt) {
    const entry = manifest.entries[path];
    entry.source_reconciliation = receipt;
    (entry.source_reconciliations ??= []).push({ ...receipt, live_content: live });
    entry.pending = { id: key(`reconcile\0${taskId}\0${path}\0${entry.latest_sha}\0${sha(live)}\0${sha(after)}`),
      before, after, before_sha: sha(before), after_sha: sha(after), recovery_before_sha: sha(live), source_reconciliation: receipt };
    await save(taskId, manifest);
    if (sha(await readOptional(path)) !== sha(live)) throw failure("TICKET_SOURCE_CHANGED", `Source changed before reconciliation write: ${path}.`);
    if (after !== live) {
      if (after === null) await fileService.deleteFile({ path });
      else await fileService.atomicWrite({ path, content: after, replace: true });
    }
  }

  // Publishes only hashes and conflict coordinates so terminal logs expose progress without repeating full source snapshots.
  function log(taskId, path, receipt) {
    projectLogger({ event_name: "ticket.source_reconciled", level: "info", status: receipt.status === "conflict" ? "blocked" : "success",
      task_id: taskId, source: "ticket-change-ledger", message: receipt.status === "conflict"
        ? "Concurrent source conflict retained; Coder must edit the observed live version with Sprint Leader guidance."
        : "Concurrent source reconciled; historical writes and current source receipt preserved.", payload: { path, ...receipt } });
  }
}
