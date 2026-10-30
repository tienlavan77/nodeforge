// Verifies Node refreshes stale ticket evidence once without asking the Coder to rerun tests.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketVerificationRecovery } from "../../src/modules/supervisor/ticket/ticket-verification-recovery.js";

// Confirms concurrent report requests share one verification recovery and preserve artifact identity.
test("Node rebuilds stale artifact once for concurrent reports", async () => {
  const context = { version: 4, state: "verified", review_commit_sha: "COMMIT", verification_artifact_id: "OLD" };
  const artifact = { artifact_id: "NEW", commit_sha: "COMMIT", status: "passed" };
  let starts = 0;
  let checks = 0;
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-A", pollMs: 1, executionContexts: {
    load: async () => context,
    update: async (_taskId, version, patch) => { assert.equal(version, 4); Object.assign(context, patch, { version: 5 }); }
  }, assertIdentity: async () => {}, assertPassedArtifact: async () => {
    checks += 1;
    if (context.verification_artifact_id !== "NEW") throw Object.assign(new Error("stale"), { code: "VERIFY_ARTIFACT_MISMATCH" });
    return artifact;
  }, startTests: async () => { starts += 1; return { job_id: "VERIFY-A", status: "running" }; }, getTestResult: async () => { context.verification_artifact_id = "NEW"; return { status: "passed" }; } });
  const [first, second] = await Promise.all([ensure(), ensure()]);
  assert.deepEqual(first, artifact);
  assert.deepEqual(second, artifact);
  assert.equal(starts, 1);
  assert.equal(checks >= 3, true);
});

// Returns terminal command failures to Coder before any new verification job can hide the repair evidence.
test("Node returns the first failed verification to Coder without rerunning the commit", async () => {
  let starts = 0;
  const diagnostic = { artifact_id: "ARTIFACT-FAIL", commands: [{ kind: "backend_tests", exit_code: 1,
    scope: "regression", disposition: "introduced_failure", baseline: { exit_code: 0 } }] };
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-R", pollMs: 1,
    executionContexts: { load: async () => ({ state: "committed", review_commit_sha: "COMMIT" }) },
    assertIdentity: async () => {},
    assertPassedArtifact: async () => { throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); },
    startTests: async () => ({ job_id: `VERIFY-${++starts}`, attempt: 1, status: "running" }),
    getTestResult: async () => ({ status: "failed", attempt: 1,
      error: { code: "VERIFY_COMMAND_FAILED", message: "36 passed, 1 failed" } }),
    getFailureDiagnostic: async () => diagnostic });
  await assert.rejects(ensure(), (error) => error.code === "VERIFY_COMMAND_FAILED"
    && error.message.includes("36 passed, 1 failed") && error.details.verification_diagnostic === diagnostic);
  assert.equal(starts, 1);
});

// Caps one suspended report request even when workspace changes reset each durable runner attempt to one.
test("runner revision changes cannot hide a failed verification behind another automatic attempt", async () => {
  let starts = 0;
  const outcomes = [];
  const diagnostic = { artifact_id: "ARTIFACT-LAST", commands: [{ kind: "backend_tests", exit_code: 1 }] };
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-CHANGING", pollMs: 1,
    executionContexts: { load: async () => ({ state: "committed", review_commit_sha: "COMMIT" }) },
    assertIdentity: async () => {},
    assertPassedArtifact: async () => { throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); },
    startTests: async () => {
      starts += 1;
      assert.equal(starts, 1, "Return the failed checks before launching another runner revision");
      return { job_id: `VERIFY-${starts}`, runner_revision: `RUNNER-${starts}`, attempt: 1, status: "running" };
    },
    getTestResult: async ({ jobId }) => ({ job_id: jobId, attempt: 1, status: "failed",
      error: { code: "VERIFY_COMMAND_FAILED", message: "backend_tests exited 1." } }),
    getFailureDiagnostic: async () => diagnostic });
  await assert.rejects(ensure({ onSettled: async (outcome) => outcomes.push(outcome) }),
    (error) => error.code === "VERIFY_COMMAND_FAILED" && error.details.verification_diagnostic === diagnostic);
  assert.equal(starts, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "failed");
});

// Preserves command evidence in the SDK error and never burns unchanged retries on a full disk.
test("storage failure returns source diagnostic immediately for dispatch and resume", async () => {
  let starts = 0;
  const diagnostic = { repairable: false, reason: "VERIFY_STORAGE_EXHAUSTED", artifact_id: "ARTIFACT-1", commands: [{ kind: "unit", argv: ["node", "--test"], exit_code: 1, stderr_redacted: "ENOSPC" }] };
  const ensure = createTicketVerificationRecovery({ taskId: "TASK", executionContexts: { load: async () => ({ state: "committed", review_commit_sha: "COMMIT" }) },
    assertIdentity: async () => {}, assertPassedArtifact: async () => { throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); },
    startTests: async () => { starts += 1; return { status: "failed", attempt: 1, error: { code: "VERIFY_STORAGE_EXHAUSTED", message: "Disk full" } }; },
    getFailureDiagnostic: async () => diagnostic });
  await assert.rejects(ensure(), (error) => error.code === "VERIFY_STORAGE_EXHAUSTED" && error.verification_diagnostic === diagnostic && error.message.includes("ARTIFACT-1"));
  assert.equal(starts, 1);
});

// A long check occupies one tool request; only Node polls, and the same session receives the terminal artifact.
test("long verification holds one report request until Node returns terminal evidence", async () => {
  const context = { state: "committed", review_commit_sha: "COMMIT", version: 1 };
  let checks = 0;
  let starts = 0;
  const transitions = [];
  let ready = false;
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-SLOW", pollMs: 1,
    executionContexts: { load: async () => context }, assertIdentity: async () => {},
    assertPassedArtifact: async () => {
      if (!ready) throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" });
      return { artifact_id: "ARTIFACT-SLOW" };
    }, startTests: async () => { starts++; return { job_id: "VERIFY-SLOW", status: "running" }; },
    getTestResult: async () => { checks++; ready = checks === 4; return { status: ready ? "passed" : "running" }; } });
  const result = await ensure({ onWaiting: async (job) => transitions.push(job.status), onSettled: async (job) => transitions.push(job.status) });
  assert.equal(result.artifact_id, "ARTIFACT-SLOW");
  assert.equal(starts, 1);
  assert.equal(checks, 4);
  assert.deepEqual(transitions, ["running", "passed"]);
});

// Stop interrupts the Node wait without returning success or waking a cancelled Coder report.
test("Stop aborts verification continuation and preserves the original cancellation", async () => {
  const controller = new AbortController();
  const stopped = Object.assign(new Error("Owner stopped"), { code: "TICKET_STOPPED" });
  const transitions = [];
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-STOP", pollMs: 1,
    executionContexts: { load: async () => ({ state: "committed", review_commit_sha: "COMMIT" }) }, assertIdentity: async () => {},
    assertPassedArtifact: async () => { throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); },
    startTests: async () => ({ job_id: "VERIFY-STOP", status: "running" }),
    getTestResult: async () => { throw new Error("Must not poll after Stop"); } });
  await assert.rejects(ensure({ abortSignal: controller.signal,
    onWaiting: async () => controller.abort(stopped), onSettled: async (outcome) => transitions.push(outcome.status) }), (error) => error === stopped);
  assert.deepEqual(transitions, ["stopped"]);
});

// A capped failed job still returns the failed command and immutable artifact to Coder without a new test run.
test("unchanged retry errors carry the existing verification diagnostic", async () => {
  const diagnostic = { artifact_id: "ARTIFACT-FAIL", evidence_ref: "artifact.json", commands: [{ argv: ["node", "--test"], exit_code: 1, stdout_redacted: "assertion failed" }] };
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-FAIL",
    executionContexts: { load: async () => ({ state: "committed", review_commit_sha: "COMMIT" }) }, assertIdentity: async () => {},
    assertPassedArtifact: async () => { throw Object.assign(new Error("Missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); },
    startTests: async () => { throw Object.assign(new Error("Unchanged"), { code: "VERIFY_RETRY_UNCHANGED" }); },
    getFailureDiagnostic: async () => diagnostic });
  await assert.rejects(ensure(), (error) => error.code === "VERIFY_RETRY_UNCHANGED" && error.details.verification_diagnostic === diagnostic
    && error.message.includes("ARTIFACT-FAIL") && !error.message.includes("assertion failed"));
});
