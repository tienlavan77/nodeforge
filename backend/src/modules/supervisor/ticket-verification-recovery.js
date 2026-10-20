// Waits for Node-owned verification before returning completion evidence to the same Coder session.
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError } from "../../shared/errors.js";

// Shares one verification recovery while keeping agent calls suspended until checks settle or Stop cancels the wait.
export function createTicketVerificationRecovery({ taskId, executionContexts, assertIdentity, assertPassedArtifact, startTests, getTestResult, getFailureDiagnostic, maxAttempts = 2, pollMs = 1000 }) {
  let recovery = null;
  return async function ensurePassedArtifact(options = {}) {
    options.abortSignal?.throwIfAborted();
    try { return await assertPassedArtifact(); }
    catch (error) { if (error.code !== "VERIFY_ARTIFACT_MISMATCH") throw error; }
    if (!recovery) recovery = recover(options).finally(() => { recovery = null; });
    return recovery;
  };

  // Reuses durable verification jobs, preserving the committed source and returning full failure diagnostics.
  async function recover({ abortSignal, onWaiting, onSettled }) {
    const context = await executionContexts.load(taskId);
    if (!context?.review_commit_sha || ["integrating", "terminal"].includes(context.state)) throw failure("VERIFY_RECOVERY_BLOCKED", "Ticket has no mutable committed context for verification recovery.");
    await assertIdentity(context);
    if (context.state !== "committed" || context.verification_artifact_id) await executionContexts.update(taskId, context.version, { state: "committed", verification_artifact_id: null });
    try {
      for (;;) {
        abortSignal?.throwIfAborted();
        const job = await startTests();
        let result = job;
        if (result.status === "running") await onWaiting?.({ job_id: job.job_id, task_id: taskId, status: "running", commit_sha: context.review_commit_sha, source_revision: context.source_revision });
        while (result.status === "running") {
          await delay(pollMs, undefined, { signal: abortSignal });
          abortSignal?.throwIfAborted();
          result = await getTestResult({ jobId: job.job_id });
        }
        abortSignal?.throwIfAborted();
        if (result.status === "passed") {
          const artifact = await assertPassedArtifact();
          abortSignal?.throwIfAborted();
          await onSettled?.({ status: "passed", job_id: job.job_id, artifact_id: artifact.artifact_id });
          return artifact;
        }
        if (result.error?.code === "VERIFY_STORAGE_EXHAUSTED" || (result.attempt ?? job.attempt ?? maxAttempts) >= maxAttempts) throw failure(result.error?.code ?? "VERIFY_RECOVERY_FAILED", result.error?.message ?? "Current ticket verification failed after bounded retries.");
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        await onSettled?.({ status: "stopped" });
        throw abortSignal.reason;
      }
      let diagnostic;
      try { diagnostic = await getFailureDiagnostic?.(); }
      catch (diagnosticError) { diagnostic = { repairable: false, diagnostic_unavailable: diagnosticError.message }; }
      if (diagnostic) {
        error.verification_diagnostic = diagnostic;
        error.details = { ...error.details, verification_diagnostic: diagnostic };
        error.message += ` Verification evidence: ${JSON.stringify(diagnostic)}`;
      }
      await onSettled?.({ status: "failed", error_code: error.code ?? "VERIFY_RECOVERY_FAILED", diagnostic });
      throw error;
    }
  }
}

// Preserves the original verification failure code for Coder and Supervisor consumers.
function failure(code, message) { return Object.assign(new ConfigurationError(message), { code }); }
