// Stores a durable Coder availability wait and exposes it to users without re-opening an already resolved technical consultation.

// Recovers the old unavailable-dispatch failure once; actual profile and occupancy are checked again before any launch.
export function restoreBlockerAgentWait(job) {
  if (job.status !== "reconciliation_required" || job.outcome_reason !== "AGENT_NOT_AVAILABLE"
    || job.resolution?.action !== "resolved" || job.agent_wait_recovered || job.approval_retry) return false;
  job.agent_wait_recovered = true;
  job.status = "resume_pending";
  delete job.outcome_reason;
  return true;
}

// Persists a timed wait only for an unstarted resume with a concrete occupancy receipt; failed profiles and unknown launches remain errors.
export function scheduleBlockerAgentWait(job, error, operation, now) {
  if (operation !== "resume_pending" || error.code !== "AGENT_BUSY" || error.not_started !== true
    || !error.agent_wait?.agent_id || !error.agent_wait.claim_id || job.resolution?.action !== "resolved") return false;
  job.agent_wait_recovered = true;
  job.status = "resume_pending";
  job.outcome_reason = "AGENT_BUSY";
  job.last_error = error.message;
  job.agent_wait = { ...error.agent_wait, available_at: now + 30_000, interval_ms: 30_000,
    attempts: (job.agent_wait?.attempts ?? 0) + 1, notified: false };
  return true;
}

// Projects the persisted queue wait into the ticket checkpoint and UI; repeated delivery is safe after a process restart.
export function createBlockerAgentWait({ store, inspect, checkpoints, ticketStatusStore, eventBus, projectLogger }) {
  return async function notifyAgentWait(job) {
    const delivered = await store.withLock("blocker.recovery", async () => {
      const ledger = (await store.list("blocker.recovery")).find((entry) => entry.jobs.some((item) => item.id === job.id));
      const currentJob = ledger?.jobs.find((entry) => entry.id === job.id);
      if (!ledger || ledger.cancelled || currentJob?.status !== "resume_pending"
        || currentJob.agent_wait?.available_at !== job.agent_wait.available_at) return null;
      const authority = await inspect(job);
      if (!authority) return null;
      const { current, checkpoint } = authority;
      const duplicate = checkpoint.blocker_recovery?.agent_wait?.available_at === job.agent_wait.available_at;
      await checkpoints.save({ ...checkpoint, phase: "agent_wait_pending", blocker_recovery: {
        ...checkpoint.blocker_recovery, job_id: job.id, status: "resume_pending", reason: "AGENT_BUSY",
        disposition: job.resolution, agent_wait: job.agent_wait } });
      if (current.status === "needs_human_review") ticketStatusStore.updateStatus(job.request.task_id, "pending",
        { ...current.details, reason: "AGENT_BUSY", agent_wait: job.agent_wait },
        { expectedVersion: current.version, expectedExecutionId: job.request.payload.execution_id });
      return { duplicate };
    });
    if (!delivered) return;
    const message = "Coder đang bận ticket khác. Node giữ checkpoint và quyết định SL, tự thử lại sau 30 giây; nhấn Stop để tạm dừng.";
    await eventBus.publish({ type: "ticket.updated", event_id: `AGENT-WAIT-${job.id}-${job.agent_wait.available_at}`,
      project_id: job.request.project_id, task_id: job.request.task_id, supervisor_id: job.request.supervisor_id,
      request_id: job.request.request_id, correlation_id: job.request.correlation_id, attempt: 1, payload: {
        ticket_id: job.request.task_id, reason: "AGENT_BUSY", message, agent_wait: job.agent_wait,
        execution_id: job.request.payload.execution_id, execution_basis: job.request.payload.sprint_basis } });
    if (!delivered.duplicate) projectLogger({ event_name: "supervisor.coder_wait_scheduled", level: "info", status: "pending",
      task_id: job.request.task_id, message, payload: { job_id: job.id, ...job.agent_wait } });
  };
}
