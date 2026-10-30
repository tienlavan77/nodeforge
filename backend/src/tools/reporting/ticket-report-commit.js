/** Lets the normal completion report reconcile a fully restored ticket source
 * through the scoped Git, ledger and execution-context services. This internal
 * callback exposes no new agent tool, arbitrary revision or write capability;
 * final verification and independent review keep their existing contracts. */
import { authorizeTool } from "../governance/tool-authorization.js";
import { ConfigurationError } from "../../shared/errors.js";

/** Checks report authorization before asking the bound ticket service for a
 * retained commit. The current manifest receives a committed context only
 * after successful byte-level reconciliation; historical artifacts stay
 * immutable and stale source evidence must pass normal verification again. */
export function createTicketReportCommit({ gitService, changeLedger, executionContexts }) {
  return async function reconcileCommit(context) {
    authorizeTool("report_done", context);
    context.abortSignal?.throwIfAborted();
    const taskId = context.task_id ?? context.taskId;
    const manifest = await changeLedger.load();
    if (manifest.task_id !== taskId || manifest.project_id !== context.project_id || context.ticket?.id !== taskId)
      throw Object.assign(new ConfigurationError("Report commit recovery belongs to another ticket or project."), { code: "TICKET_COMMIT_SCOPE" });
    const saved = await executionContexts.load(taskId);
    if (!saved || saved.task_id !== taskId || saved.project_id !== manifest.project_id || ["terminal", "integrating"].includes(saved.state))
      throw Object.assign(new ConfigurationError("Report commit recovery requires a live same-ticket execution context."), { code: "TICKET_CONTEXT_FROZEN" });
    const result = await gitService.reconcileRestoredCommit();
    if (!result) return null;
    const latest = await changeLedger.snapshot();
    if (latest.revision !== result.revision || latest.commits[latest.revision] !== result.sha)
      throw Object.assign(new ConfigurationError("Ticket changed during report commit recovery."), { code: "TICKET_REVISION_CHANGED" });
    context.abortSignal?.throwIfAborted();
    let current = await executionContexts.syncManifest(taskId, latest);
    if (current.review_commit_sha !== result.sha || !["committed", "verified", "reviewing"].includes(current.state))
      current = await executionContexts.update(taskId, current.version, { state: "committed", review_commit_sha: result.sha, verification_artifact_id: null, verification_source: null });
    context.execution_context = current;
    return result;
  };
}
