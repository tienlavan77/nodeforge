/** Verifies agent responses carry repair-only errors and immutable references,
 * while passing receipts and accepted baseline regressions stay Node-owned. */
import assert from "node:assert/strict";
import test from "node:test";
import { ticketVerificationResult, ticketFocusedCheckResult } from "../../src/modules/supervisor/ticket/ticket-verification-result.js";
import { regressionFailureIdentity } from "../../src/modules/supervisor/ticket/ticket-verification-regression.js";
import { createHash } from "node:crypto";

// Builds genuine comparable baseline evidence, rather than trusting an agent's
// label that a failed supplemental command has already been accepted.
function preexisting() {
  const command = { kind: "test", scope: "regression", disposition: "preexisting_failure", test_paths: ["old.test.js"], argv: ["node", "--test", "old.test.js"],
    cwd: "/ticket", exit_code: 1, stdout_redacted: '{"type":"failure","name":"old","file":"old.test.js","error":{"message":"old defect"}}\n{"type":"summary","failed":1,"cancelled":0}', stderr_redacted: "" };
  command.failure_sha256 = regressionFailureIdentity(command, command, command.cwd);
  command.baseline = { ...command, cwd: "/baseline", commit_sha: "BASE", environment_sha256: "ENV",
    output_sha256: `sha256:${createHash("sha256").update("baseline output").digest("hex")}` };
  return command;
}

test("failed job response contains only blocking errors without aggregate or passing log duplication", () => {
  const job = { job_id: "VERIFY-1", task_id: "T", status: "failed", artifact_id: "ARTIFACT-1", result: { status: "failed", breakdown: ["PASS-LOG"] } };
  const artifact = { artifact_id: "ARTIFACT-1", stdout_redacted: "ALL-LOGS", commands: [
    { kind: "lint", exit_code: 0, stdout_redacted: "PASS-LOG" }, preexisting(),
    { kind: "test", exit_code: 1, stdout_redacted: "specific assertion", stderr_redacted: "repair cause", test_paths: ["ticket.test.js"] }] };
  const result = ticketVerificationResult(job, artifact);
  assert.equal(result.commands.length, 1);
  assert.match(result.commands[0].stdout_redacted, /specific assertion/);
  assert.match(result.evidence_ref, /ARTIFACT-1.json$/);
  for (const value of ["ALL-LOGS", "PASS-LOG", "old defect"]) assert(!JSON.stringify(result).includes(value));
  assert.equal(artifact.commands.length, 3);
});

test("passed verification returns status and receipt identity without passing command output", () => {
  const result = ticketVerificationResult({ job_id: "VERIFY-1", task_id: "T", status: "passed", artifact_id: "ARTIFACT-1",
    result: { status: "passed", ready_for_review: true, commit_id: "COMMIT", artifact_id: "ARTIFACT-1", breakdown: ["PASS-LOG"] } },
  { artifact_id: "ARTIFACT-1", commands: [{ kind: "test", exit_code: 0, stdout_redacted: "PASS-LOG" }] });
  assert.equal(result.result.ready_for_review, true);
  assert.equal(result.result.commit_id, "COMMIT");
  assert.deepEqual(result.commands, []);
  assert(!JSON.stringify(result).includes("PASS-LOG"));
});

test("focused check lookups keep environment/identity but return output only on failure", () => {
  const check = { check_id: "CHECK-1", status: "passed", environment: { sha256: "ENV" }, stdout: "PASS-LOG", stderr: "routine warning" };
  const passed = ticketFocusedCheckResult(check);
  assert.deepEqual(passed.environment, check.environment);
  assert.equal(passed.stdout_redacted, "");
  assert(!JSON.stringify(passed).includes("PASS-LOG"));
  const failed = ticketFocusedCheckResult({ ...check, status: "failed", stdout: "assertion failed" });
  assert.equal(failed.stdout_redacted, "assertion failed");
});
