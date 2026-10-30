// Recovers dependency dispatch rejected before provider launch by an archived finding key or an unacknowledged duplicate RUN.
// Only an untouched, receipt-bound repair can resume; Stop, source changes and unknown provider outcomes remain authoritative.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { acquireTicketFileLock } from "../ticket/ticket-file-lock.js";
import { DEPENDENCY_REPAIR_QUEUE as QUEUE } from "./dependency-repair-queue.js";

// Reattaches the accepted SL request after proving that its new journal has not performed any agent work.
// The recovering marker survives interruption between queue, checkpoint and parent-ledger writes.
export async function recoverDependencyRepairCheckpoint(entry, { store, ticketStatusStore, checkpoints, disposition,
  resolveTicketWorkspace, fileService, validateTarget, clock }) {
  const duplicate = entry.status === "failed" && entry.error?.code === "DEPENDENCY_REPAIR_CONFLICT" && entry.dispatch_result?.status === "already_running"
    || entry.status === "recovering" && entry.checkpoint_recovery?.kind === "dispatch_not_started";
  if (!duplicate && !(entry.status === "failed" && entry.error?.code === "REVIEW_REPAIR_SOURCE_CONFLICT")
    && !(entry.status === "recovering" && entry.checkpoint_recovery?.kind === "archived_finding_key")) return false;
  return store.withLock("blocker.recovery", async () => {
    const ledger = (await store.list("blocker.recovery")).find((item) => item.task_id === entry.parent.task_id
      && item.project_id === entry.parent.project_id && item.execution_id === entry.parent.execution_id);
    const job = ledger?.jobs.find((item) => item.id === entry.parent.job_id);
    const parent = ticketStatusStore.get(entry.parent.task_id), target = ticketStatusStore.get(entry.target.ticket.id);
    if (!job || ledger.cancelled || job.stage !== "sprint_leader" || job.resolution
      || ["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(job.outcome_reason)
      || job.dependency_request_id !== entry.id || !["dependency_wait", "reconciliation_required"].includes(job.status)
      || job.status === "reconciliation_required" && job.dependency_result?.request_id !== entry.id
      || !["pending", "running", "needs_human_review"].includes(parent?.status) || parent.details.launch_claim || parent.details.execution_id !== entry.parent.execution_id
      || parent.details.reason === "TICKET_STOPPED" || !["pending", "failed"].includes(target?.status) || target.details.launch_claim
      || target.project_id !== entry.parent.project_id || target.details.execution_id !== entry.target.execution_id || target.details.reason === "TICKET_STOPPED"
      || target.details.dependency_repair?.id !== entry.id
      || (await disposition?.get(entry.parent.task_id))?.disposition === "cancelled"
      || (await disposition?.get(entry.target.ticket.id))?.disposition === "cancelled") return false;
    await validateTarget(entry);
    const lock = await acquireTicketFileLock(fileService, `${statePath()}/automatic-review-locks/OWNER-${entry.target.ticket.id}.lock`);
    try {
      const coder = await checkpoints.load(entry.target.ticket.id);
      const workspace = await resolveTicketWorkspace(entry.target.ticket.id);
      const context = await workspace.executionContexts.load(entry.target.ticket.id);
      const manifest = await workspace.changeLedger.load();
      const scope = createHash("sha256").update(entry.parent.project_id).digest("hex");
      const receipt = JSON.parse(await fileService.readFile({ path: `${statePath()}/ticket-review-repairs/${scope}/${entry.target.ticket.id}/${entry.id}.json` }));
      const key = entry.checkpoint_recovery?.review_repair_key ?? coder?.review_repair_key;
      if (coder?.status !== "in_progress" || coder.phase !== "dependency_repair" || coder.dependency_repair?.id !== entry.id
        || coder.review_cycle_id !== entry.id || coder.changed_paths?.length || coder.completed_tools?.length
        || coder.review_repair_key && coder.review_repair_key !== key || !duplicate && !/^sha256:[a-f0-9]{64}$/.test(key ?? "")
        || receipt.phase !== "ready" || receipt.cycle_id !== entry.id || receipt.task_id !== entry.target.ticket.id
        || receipt.project_id !== entry.parent.project_id || !duplicate && receipt.context?.source_repair_cycle_id !== key.slice(7)
        || !isDeepStrictEqual(receipt.binding, entry.integrated_binding) || context?.state !== "coding"
        || context.task_id !== entry.target.ticket.id || context.project_id !== entry.parent.project_id
        || context.review_repair_cycle_id !== entry.id || context.source_repair_cycle_id
        || !isDeepStrictEqual({ ...context, version: coder.execution_context?.version, updated_at: coder.execution_context?.updated_at }, coder.execution_context)
        || context.version < receipt.context.version + 1
        || manifest.review_repair_cycle_id !== entry.id || manifest.state !== "active" || manifest.pending_commit
        || Object.keys(manifest.entries).length || Object.keys(manifest.commits).length
        || manifest.revision !== receipt.manifest.revision + 1
        || !isDeepStrictEqual(workspace.executionContexts.manifestIdentity(manifest), {
          source_revision: context.source_revision, manifest_sha: context.manifest_sha, manifest_paths: context.manifest_paths })) return false;
      const recovering = await store.withLock(QUEUE, async () => {
        const current = (await store.list(QUEUE)).find((item) => item.id === entry.id);
        if (!current || current.status !== entry.status || current.owner) return null;
        const next = { ...current, status: "recovering", checkpoint_recovery: { kind: duplicate ? "dispatch_not_started" : "archived_finding_key", review_repair_key: key }, updated_at: clock() };
        await store.save(QUEUE, next); return next;
      });
      if (!recovering) return false;
      const resumed = { ...coder };
      delete resumed.review_repair_key; delete resumed.repair_implementation_required; delete resumed.review_findings;
      await checkpoints.save(resumed);
      job.status = "dependency_wait";
      job.history.push({ stage: "sprint_leader", event: "dependency_checkpoint_recovered", request_id: entry.id, completed_at: clock() });
      delete job.dependency_result; delete job.dependency_result_consumed; delete job.resolution; delete job.last_error; delete job.outcome_reason;
      await store.save("blocker.recovery", ledger);
      await store.withLock(QUEUE, async () => {
        const current = (await store.list(QUEUE)).find((item) => item.id === entry.id);
        if (current?.status === "recovering") await store.save(QUEUE, { ...current, status: "queued", error: null, dispatch_result: null, owner: null, available_at: null, updated_at: clock() });
      });
      return true;
    } finally { await lock.release(); }
  });
}
