/** Dispatches Node-owned baseline work before consulting read-only recovery roles.
 * Queue ownership, Stop and ticket identity fence both command execution and later
 * evidence publication; no Coder claim or additional agent permission is needed. */
// Defines createBlockerBaselineRecovery function behavior for blocker-baseline-recovery.js.
export function createBlockerBaselineRecovery({ store, inspect, logger = console }) {
  return async (job) => {
    if (job.status !== "invoking" || !["sprint_leader", "architecture_manager"].includes(job.stage)) return null;
    const authority = await inspect(job);
    const recover = authority?.workspace.testService?.recoverBaseline;
    if (!recover) return null;
    const controller = new AbortController();
    let checking = false;
    /** Checks the persisted reservation rather than accepting a late provider result after Stop. */
    async function assertActive() {
      controller.signal.throwIfAborted();
      const ledger = (await store.list("blocker.recovery")).find(entry => entry.project_id === job.request.project_id
        && entry.task_id === job.request.task_id && entry.execution_id === job.request.payload.execution_id);
      const current = ledger?.jobs.find(entry => entry.id === job.id);
      if (ledger?.cancelled || !current || current.status !== job.status || current.stage !== job.stage
        || current.invocation_id !== job.invocation_id || !await inspect(job))
        throw Object.assign(new Error("Baseline recovery no longer owns the ticket execution."), { code: "VERIFY_RECOVERY_CANCELLED" });
    }
    /** Aborts a live test promptly when Stop or replacement revokes the reservation. */
    async function monitor() {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try { await assertActive(); }
      catch (error) {
        logger.warn?.("Baseline recovery execution revoked.", { task_id: job.request.task_id, code: error.code, error: error.message });
        controller.abort(error);
      } finally { checking = false; }
    }
    const timer = setInterval(monitor, 1000);
    timer.unref?.();
    try { return await recover({ executionId: job.request.payload.execution_id, signal: controller.signal, assertActive }); }
    catch (error) {
      await assertActive();
      logger.error?.("Baseline evidence preparation failed; returning the original diagnostic to recovery coordination.",
        { task_id: job.request.task_id, code: error.code, error: error.message });
      return { status: "unavailable", error: { code: error.code ?? "VERIFY_BASELINE_RECOVERY_FAILED", message: error.message } };
    }
    finally { clearInterval(timer); }
  };
}
