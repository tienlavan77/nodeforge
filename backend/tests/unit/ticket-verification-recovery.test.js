// Verifies Node refreshes stale ticket evidence once without asking the Coder to rerun tests.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketVerificationRecovery } from "../../src/modules/supervisor/ticket-verification-recovery.js";

// Confirms concurrent report requests share one verification recovery and preserve artifact identity.
test("Node rebuilds stale artifact once for concurrent reports", async () => {
  const context = { version: 4, state: "verified", review_commit_sha: "COMMIT", verification_artifact_id: "OLD" };
  const artifact = { artifact_id: "NEW", commit_sha: "COMMIT", status: "passed" };
  let starts = 0;
  let checks = 0;
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-A", executionContexts: {
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

// A failed command is retried by Node on the same commit without another Coder call.
test("Node automatically uses the second verification attempt and then stops", async () => {
  const context = { version: 1, state: "committed", review_commit_sha: "COMMIT", verification_artifact_id: null };
  let starts = 0;
  const ensure = createTicketVerificationRecovery({ taskId: "TICKET-R", executionContexts: { load: async () => context, update: async () => {} }, assertIdentity: async () => {},
    assertPassedArtifact: async () => {
      if (starts < 2) throw Object.assign(new Error("missing"), { code: "VERIFY_ARTIFACT_MISMATCH" });
      return { artifact_id: "ARTIFACT-2" };
    },
    startTests: async () => ({ job_id: `VERIFY-${++starts}`, attempt: starts, status: "running" }),
    getTestResult: async ({ jobId }) => ({ job_id: jobId, attempt: Number(jobId.slice(-1)), status: jobId === "VERIFY-1" ? "failed" : "passed" }) });
  assert.deepEqual(await ensure(), { artifact_id: "ARTIFACT-2" });
  assert.equal(starts, 2);

  let failedStarts = 0;
  const blocked = createTicketVerificationRecovery({ taskId: "TICKET-B", executionContexts: { load: async () => context, update: async () => {} }, assertIdentity: async () => {}, assertPassedArtifact: async () => { throw Object.assign(new Error("missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); },
    startTests: async () => ({ job_id: `VERIFY-${++failedStarts}`, attempt: failedStarts, status: "running" }),
    getTestResult: async ({ jobId }) => ({ job_id: jobId, attempt: Number(jobId.slice(-1)), status: "failed", error: { code: "TEST_FAILED", message: "Test failed." } }) });
  await assert.rejects(blocked(), { code: "TEST_FAILED" });
  assert.equal(failedStarts, 2);
});
