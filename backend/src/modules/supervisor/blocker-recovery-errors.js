/** Contains recovery storage faults at the job boundary so one unreadable
 * receipt cannot starve unrelated tickets. Errors retain their original code,
 * message and stack for persisted diagnostics, with a timed refresh retry. */

/** Preserves non-enumerable Error diagnostics when the runtime logger spreads
 * structured details, and identifies the ticket and recovery stage if known. */
export function blockerRecoveryError(error, job) {
  return { event_name: job ? "supervisor.blocker_refresh_failed" : "supervisor.blocker_poll_failed",
    task_id: job?.request?.task_id, project_id: job?.request?.project_id, job_id: job?.id, stage: job?.stage,
    error_code: error.code ?? "BLOCKER_RECOVERY_FAILED", error: error.message, stack: error.stack, path: error.path };
}

/** Retries a failed read-only refresh after 30 seconds while allowing the same
 * poll to process other jobs. It retains the failing job's checkpoint and never
 * converts a storage failure into an authority decision or provider dispatch. */
export function createBlockerWaitingRefresh({ refreshWaiting, logger, clock }) {
  const retries = new Map();
  return async (job) => {
    if (clock() < (retries.get(job.id) ?? 0)) return null;
    try {
      const result = await refreshWaiting(job);
      retries.delete(job.id);
      return result;
    } catch (error) {
      const retryAt = clock() + 30_000;
      retries.set(job.id, retryAt);
      logger.error?.(`Blocker recovery refresh failed (${error.code ?? "BLOCKER_RECOVERY_FAILED"}); retry in 30s: ${error.message}`,
        { ...blockerRecoveryError(error, job), retry_at: retryAt });
      return null;
    }
  };
}
