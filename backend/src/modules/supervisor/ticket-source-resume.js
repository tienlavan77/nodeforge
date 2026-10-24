/** Reopens ticket claims while treating live source changes as agent context.
 * Coder dispatch observes drift without adopting it; explicit governed successor
 * integration remains separate from fresh-checksum writes and commit validation. */
import { randomUUID } from "node:crypto";

/** Shares the ledger locks and storage contracts so resumed agents preserve
 * journal history and other tickets retain ownership until an actual write. */
export function createTicketSourceResume({ observe, locked, load, claim, recover, readOptional, sha, key, failure, save, projectLogger, fileService, claimPath, projectId }) {
  return resume;

  // Reclaims unchanged file claims for commits, while Coder dispatch may inspect changed or
  // foreign-owned files without permission to overwrite them. Explicit successor adoption
  // still requires an unambiguous completed integration chain.
  async function resume(taskId, { integrated_successors = [], observe_changes = false } = {}) {
    if (observe_changes) await observe(taskId);
    return locked(`ticket:${taskId}`, async () => {
      let manifest = await load(taskId);
      if (manifest.state === "closed") return;
      const acquired = [];
      try {
        const drift = [];
        for (const [path, entry] of Object.entries(manifest.entries)) await locked(`path:${path}`, async () => {
          const owner = await claim(path);
          if (owner && owner.task_id !== taskId) {
            if (observe_changes) return;
            throw failure("FILE_CLAIM_CONFLICT", `${path} is owned by ticket ${owner.task_id}.`);
          }
          if (entry.pending) manifest = await recover(taskId, path, manifest);
          const live = await readOptional(path);
          if (sha(live) === manifest.entries[path].latest_sha) return;
          const receipt = manifest.entries[path].source_reconciliation;
          if ((receipt?.status === "conflict" || observe_changes && receipt?.status === "changed" && !integrated_successors.length) && receipt.live_sha === sha(live)) return;
          drift.push({ path, live, live_sha: sha(live) });
        });
        // An unexplained changed root always fails closed; every drifted path must be covered by
        // exactly one approved governed successor before this ticket may adopt its integrated content.
        const rebased = [];
        for (const item of drift) {
          const matches = [];
          for (const successorTaskId of integrated_successors) {
            const evidence = await governedSuccessorIntegration(manifest.entries[item.path], item.live, item.live_sha, successorTaskId);
            if (evidence) matches.push({ successorTaskId, ...evidence });
          }
          if (matches.length !== 1) {
            if (observe_changes) continue;
            throw failure("TICKET_SOURCE_CHANGED", `Root source changed outside ticket ${taskId}: ${item.path}.`);
          }
          const entry = manifest.entries[item.path];
          const integrated = matches[0];
          entry.operations.push({ id: key(`integrated\0${taskId}\0${item.path}\0${integrated.successorTaskId}\0${item.live_sha}`),
            before_sha: entry.latest_sha, after_sha: item.live_sha, before: null, after: item.live,
            revision: manifest.revision + 1, status: "completed", integrated_from: integrated.successorTaskId });
          entry.latest_sha = item.live_sha;
          manifest.revision += 1;
          rebased.push({ path: item.path, successorTaskId: integrated.successorTaskId, commit_sha: integrated.commit_sha, revision: manifest.revision });
        }
        if (rebased.length) {
          await save(taskId, manifest);
          for (const rebase of rebased) projectLogger({ event_name: "ticket.source_integration_rebased", level: "info", status: "success",
            message: "Root source was adopted from its approved governed successor ticket.", task_id: taskId, source: "ticket-change-ledger",
            payload: { path: rebase.path, successor_task_id: rebase.successorTaskId, commit_sha: rebase.commit_sha, revision: rebase.revision } });
        }
        for (const [path, entry] of Object.entries(manifest.entries)) await locked(`path:${path}`, async () => {
          if (await claim(path)) return;
          if (observe_changes && sha(await readOptional(path)) !== entry.latest_sha) return;
          await fileService.atomicWrite({ path: claimPath(path), content: JSON.stringify({ task_id: taskId, path, claim_id: entry.claim_id ?? randomUUID() }), replace: false });
          acquired.push(path);
        });
      } catch (error) {
        for (const path of acquired) await locked(`path:${path}`, async () => { if ((await claim(path))?.task_id === taskId) await fileService.deleteFile({ path: claimPath(path) }); });
        throw error;
      }
    });
  }

  // Proves one root file's live content arrived only through a closed and integrated governed successor ticket.
  async function governedSuccessorIntegration(entry, live, liveSha, successorTaskId) {
    if (!successorTaskId || successorTaskId === entry?.path) return null;
    const successor = await load(successorTaskId);
    const source = successor.entries?.[entry.path];
    if (successor.task_id !== successorTaskId || successor.project_id !== projectId || successor.state !== "closed" || !source || source.pending) return null;
    // Chain continuity: the successor began exactly at this ticket's last recorded state and ends at live content.
    if (source.initial_sha !== entry.latest_sha || source.latest_sha !== liveSha || sha(live) !== liveSha) return null;
    const operations = source.operations ?? [];
    if (!operations.length || operations.some((operation) => operation.status !== "completed" || operation.pending)) return null;
    let cursor = source.initial_sha;
    for (const operation of operations) { if (operation.before_sha !== cursor) return null; cursor = operation.after_sha; }
    if (cursor !== source.latest_sha) return null;
    const lastRevision = Math.max(...operations.map((operation) => operation.revision));
    const commits = Object.entries(successor.commits ?? {}).filter(([revision, commit]) => Number(revision) >= lastRevision && /^[a-f0-9]{40,64}$/i.test(commit));
    if (!commits.length) return null;
    return { commit_sha: commits[0][1], revision: Number(commits[0][0]) };
  }
}
