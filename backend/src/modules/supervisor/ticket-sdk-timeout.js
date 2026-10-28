// Restores truthful ticket failure and manual Resume after a local SDK deadline.
// Reconciliation requires the exact launch, checkpoint and stopped process; it preserves
// source edits, provider session identity and prior coordination decisions without replay.
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { releaseTicketAttempt } from "./ticket-attempt-release.js";
import { handleTicketExecutionFailure } from "./ticket-execution-failure.js";

// Confirms an SDK-generated timeout against its local runner rather than agent response text.
// Unknown or still-active processes remain owned; a confirmed stop permits explicit Resume only.
export async function confirmTicketSdkTimeout({ error, checkpoint, selected, gateway, checkpoints, requestId, projectLogger = () => {} }) {
  if (!["codex", "claude", "anthropic"].includes(selected?.provider) || (selected.provider === "codex" ? checkpoint?.provider !== "codex" : !["claude", "anthropic"].includes(checkpoint?.provider)) || checkpoint.agent_id !== selected.agent_id
    || !["blocked", "failed", ...(checkpoint.provider !== "codex" ? ["in_progress"] : [])].includes(checkpoint.status) || typeof gateway?.assertSessionStopped !== "function") return false;
  const legacy = error?.code === "CONFIGURATION_ERROR" && error.message === `${checkpoint.provider === "codex" ? "Codex" : "Claude"} SDK request timed out for ${selected.agent_id}.`;
  if (error?.code !== "SDK_REQUEST_TIMEOUT" && !legacy) return false;
  if (checkpoints && requestId) await checkpoints.save({ ...checkpoint, status: "failed", phase: "sdk_timeout_pending", failure_request_id: requestId,
    failure: { code: "SDK_REQUEST_TIMEOUT", message: error.message, at: new Date().toISOString() } });
  try { await gateway.assertSessionStopped({ agentId: selected.agent_id, threadId: checkpoint.thread_id, sessionId: checkpoint.session_id,
    endedAt: checkpoint.failure?.message === error.message ? checkpoint.failure.at : undefined }); }
  catch (probeError) {
    projectLogger({ event_name: "ticket.timeout_reconciliation_pending", level: "warn", status: "blocked", task_id: checkpoint.task_id,
      message: "SDK timeout retained until the previous local runner is confirmed stopped.",
      payload: { code: probeError.code ?? "PROCESS_PROBE_FAILED", error: probeError.message } });
    return false;
  }
  Object.assign(error, { code: "SDK_REQUEST_TIMEOUT", provider_outcome: "failed", retry_safe: false, resume_allowed: true });
  return true;
}

// Reconciles persisted timeouts after API restart without launching an agent or clearing its history.
// Exact request and execution fences prevent an old timeout from releasing a newer ticket owner.
export async function recoverTicketSdkTimeout({ taskId, ticketStatusStore, checkpoints, codexSdkGateway, claudeSdkGateway, queueStore,
  handoffQueue, resolveTicketWorkspace, agentOccupancy, eventBus, projectLogger = () => {} }) {
  const current = ticketStatusStore?.get?.(taskId);
  if (!current || !["running", "reviewing", "failed", "pending"].includes(current.status)) return false;
  const previous = current.details.launch_reconciliation ?? current.details.last_failure?.details?.launch_reconciliation;
  if (!current.details.launch_claim && !previous?.receipt) return false;
  const checkpoint = await checkpoints.load(taskId);
  const receipt = current.details.launch_claim ?? (checkpoint?.phase === "sdk_timeout" && checkpoint.status === "failed"
    && previous?.disposition === "executor_failed" ? previous.receipt : null);
  if (!receipt || !current.details.launch_claim && checkpoint.sdk_timeout_reconciled?.request_id === receipt.request_id) return false;
  if (!checkpoint?.failure || checkpoint.task_id !== taskId || checkpoint.agent_id !== receipt.agent_id
    || Date.parse(checkpoint.failure.at) < Date.parse(receipt.claimed_at)
    || !Number.isFinite(Date.parse(checkpoint.failure.at)) || !Number.isFinite(Date.parse(receipt.claimed_at))) return false;
  const error = Object.assign(new Error(checkpoint.failure.message), { code: checkpoint.failure.code });
  if (!await confirmTicketSdkTimeout({ error, checkpoint, selected: { provider: checkpoint.provider, agent_id: receipt.agent_id }, gateway: checkpoint.provider === "codex" ? codexSdkGateway : claudeSdkGateway, projectLogger })) return false;
  const request = (await queueStore.list("sender.handoff")).find((job) => job.id === receipt.job_id && job.request_id === receipt.request_id
    && job.task_id === taskId && job.project_id === current.project_id && job.correlation_id === checkpoint.correlation_id
    && matchesTicketExecution(current, job.payload?.execution_id, job.payload?.sprint_basis));
  const legacyResume = checkpoint.phase === "blocker_resolved" && checkpoint.blocker_recovery?.status === "resolved"
    && receipt.request_id === `BLOCKER-RESUME-${checkpoint.blocker_recovery.job_id}`;
  if (!request || checkpoint.failure_request_id && checkpoint.failure_request_id !== request.request_id && !legacyResume) return false;
  const workspace = await resolveTicketWorkspace?.(taskId);
  const latest = ticketStatusStore.get(taskId);
  const latestReceipt = latest.details.launch_claim ?? previous?.receipt;
  if (latest.version !== current.version || latestReceipt?.request_id !== receipt.request_id) return false;
  await handoffQueue.quarantine(receipt.job_id, { requestId: receipt.request_id, reason: error.code });
  await checkpoints.save({ ...checkpoint, status: "failed", phase: "sdk_timeout", failure_request_id: request.request_id,
    failure: { ...checkpoint.failure, code: error.code, resume_allowed: true } });
  if (latest.details.launch_claim) ticketStatusStore.reconcileExecutionLaunch(taskId, { executionId: receipt.execution_id, requestId: receipt.request_id, jobId: receipt.job_id, disposition: "executor_failed" });
  const settled = ticketStatusStore.get(taskId);
  if (["running", "reviewing"].includes(settled.status)) ticketStatusStore.updateStatus(taskId, "failed", { ...settled.details, reason: error.code, error: error.message },
    { expectedVersion: settled.version, expectedExecutionId: receipt.execution_id });
  await releaseTicketAttempt({ workspace, agentOccupancy, claim: receipt, taskId, ownerId: receipt.supervisor_id, reason: "sdk_timeout" });
  await handleTicketExecutionFailure({ error, failedRequest: request, selected: { agent_id: receipt.agent_id }, claim: receipt,
    taskId, ownerId: receipt.supervisor_id, checkpoints, agentOccupancy, projectLogger,
    publishTicketOutcome: (type, request, ownerId, payload) => eventBus.publish({ type, event_id: `SDK-TIMEOUT-${receipt.execution_id}-${receipt.request_id}`,
      project_id: current.project_id, task_id: taskId, request_id: request.request_id, correlation_id: request.correlation_id,
      supervisor_id: ownerId, attempt: request.attempt ?? 1, payload: { ...payload, execution_id: receipt.execution_id, execution_basis: receipt.execution_basis } }) });
  await queueStore.withLock("blocker.recovery", async () => {
    for (const ledger of await queueStore.list("blocker.recovery")) {
      if (ledger.project_id !== current.project_id || ledger.task_id !== taskId || ledger.execution_id !== receipt.execution_id) continue;
      const job = ledger.jobs.find((job) => `BLOCKER-RESUME-${job.id}` === receipt.request_id && job.resolution?.action === "resolved");
      if (!job) continue;
      job.status = "resumed"; job.outcome_reason = error.code; job.last_error = error.message;
      await queueStore.save("blocker.recovery", ledger);
    }
  });
  const saved = await checkpoints.load(taskId);
  await checkpoints.save({ ...saved, sdk_timeout_reconciled: { execution_id: receipt.execution_id, request_id: receipt.request_id } });
  return true;
}
