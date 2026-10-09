// Prevents restart recovery from releasing or redispatching a launch whose provider disposition remains unknown.

// Retains unresolved execution ownership instead of trusting checkpoint or Supervisor terminal projections.
export function retainUnreconciledLaunch({ taskId, ticketStatusStore, projectLogger }) {
  const receipt = ticketStatusStore?.get?.(taskId)?.details?.launch_claim;
  if (!receipt) return false;
  projectLogger({ event_name: "supervisor.launch_reconciliation_required", level: "warn", status: "blocked", message: "Retained launch ownership blocks automatic recovery release and resume until provider disposition is reconciled.", task_id: taskId, source: "ticket-launch-recovery", payload: { execution_id: receipt.execution_id, request_id: receipt.request_id, job_id: receipt.job_id, claim_id: receipt.claim_id, supervisor_id: receipt.supervisor_id } });
  return true;
}
