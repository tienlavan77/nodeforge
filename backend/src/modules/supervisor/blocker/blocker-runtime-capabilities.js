/** Publishes factual runtime operations to recovery agents. A newly installed
 * operation can reopen an informational tooling question once; it never grants
 * approval, proves restored source, or dispatches Coder without SL's decision. */
import { isDeepStrictEqual } from "node:util";

/** Describes only installed services, with the existing agent entrypoints and
 * their validation contract. Source eligibility is checked when invoked, not
 * inferred from these capability facts or from the agent's narrative. */
export function blockerRuntimeCapabilities(workspace) {
  return { ...(typeof workspace.gitService?.reconcileRestoredCommit === "function" ? {
    restored_ticket_commit: { version: 1, tool: "report_done", retry_tool: "commit_changes", input: "existing tool schemas; no extra recovery fields",
      behavior: "Reassociate the current ledger revision with its recorded same-ticket commit only when every ticket path matches the commit and live bytes. No new Git commit is created.",
      verification: "Current execution-context verification is still required; historical artifacts remain immutable and do not become current evidence automatically." }
  } : {}), ...(typeof workspace.testService?.recoverBaseline === "function" ? {
    baseline_recovery: { version: 1, executor: "node", trigger: "retained VERIFY_BASELINE_UNAVAILABLE before SL/AM consultation",
      input: "Original artifact, commit, source revision, recorded environment and unresolved verification-plan suffix",
      behavior: "Node runs candidate and baseline in the recorded environment, preserves passing checks, completes remaining planned checks and returns receipts. No Coder claim, external operator or new Owner approval is needed for this existing runner operation. Missing source/environment remains a technical failure; a receipt never fabricates acceptance." }
  } : {}) };
}

/** Returns a parked information request to SL after a real runtime capability
 * change. Execution inspection, typed question ownership and persisted facts
 * prevent Stop, unknown provider outcomes and unchanged polls from replaying. */
export async function refreshBlockerRuntimeCapabilities(job, { inspect, clock, projectLogger, runtimeCapabilities = {} }) {
  const work = job.resolution?.reconciliation;
  const dependency = work?.kind === "dependency" && runtimeCapabilities.dependency_repair?.supported === true
    && job.architecture_response?.execution_id === job.request.payload?.execution_id
    && !job.dependency_request_id
    && !isDeepStrictEqual(runtimeCapabilities.dependency_repair, job.ticket_progress?.runtime_capabilities?.dependency_repair);
  const tooling = work?.kind === "tooling" && work.owner_request?.kind === "information"
    && work.waiting_for?.some((entry) => entry?.owner === "external");
  if (job.status !== "reconciliation_required" || job.stage !== "sprint_leader"
    || job.outcome_reason !== "technical_reconciliation_waiting_for_evidence"
    || (!dependency && !tooling)) return false;
  const authority = await inspect(job);
  if (!authority) return false;
  const capabilities = { ...blockerRuntimeCapabilities(authority.workspace), ...runtimeCapabilities };
  if (!Object.keys(capabilities).length || isDeepStrictEqual(capabilities, job.ticket_progress?.runtime_capabilities)) return false;
  job.history.push({ stage: "sprint_leader", event: "runtime_capabilities_refreshed", completed_at: clock(),
    previous_resolution: job.resolution, previous_runtime_capabilities: job.ticket_progress?.runtime_capabilities ?? null });
  job.ticket_progress = { ...job.ticket_progress, runtime_capabilities: capabilities };
  delete job.resolution;
  delete job.validation_feedback;
  projectLogger({ event_name: "supervisor.blocker_runtime_capabilities_refreshed", level: "info", status: "pending", task_id: job.request.task_id,
    message: "Installed runtime operations delivered to Sprint Leader; reassess the retained prerequisite.", payload: { job_id: job.id, runtime_capabilities: capabilities } });
  return true;
}
