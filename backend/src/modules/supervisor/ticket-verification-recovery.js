// Rebuilds ticket verification evidence when a committed revision has a stale artifact.
import { ConfigurationError } from "../../shared/errors.js";

// Lets Node recover one stale artifact at a time without sending work back to the Coder.
export function createTicketVerificationRecovery({ taskId, executionContexts, assertIdentity, assertPassedArtifact, startTests, getTestResult, maxAttempts = 2 }) {
  let recovery = null;
  return async function ensurePassedArtifact() {
    try { return await assertPassedArtifact(); }
    catch (error) { if (error.code !== "VERIFY_ARTIFACT_MISMATCH") throw error; }
    if (!recovery) recovery = recover().finally(() => { recovery = null; });
    return recovery;
  };

  // Replaces only the context link; immutable old artifacts remain as audit evidence.
  async function recover() {
    const context = await executionContexts.load(taskId);
    if (!context?.review_commit_sha || ["integrating", "terminal"].includes(context.state)) throw failure("VERIFY_RECOVERY_BLOCKED", "Ticket has no mutable committed context for verification recovery.");
    await assertIdentity(context);
    if (context.state !== "committed" || context.verification_artifact_id) await executionContexts.update(taskId, context.version, { state: "committed", verification_artifact_id: null });
    for (;;) {
      const job = await startTests();
      let result = job;
      while (result.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = await getTestResult({ jobId: job.job_id });
      }
      if (result.status === "passed") return assertPassedArtifact();
      if ((result.attempt ?? job.attempt ?? maxAttempts) >= maxAttempts) throw failure(result.error?.code ?? "VERIFY_RECOVERY_FAILED", result.error?.message ?? "Current ticket verification failed after bounded retries.");
    }
  }
}

// Preserves the verification failure code for Supervisor and report consumers.
function failure(code, message) { return Object.assign(new ConfigurationError(message), { code }); }
