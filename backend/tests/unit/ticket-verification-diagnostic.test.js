// Verifies source-bound command diagnostics survive failure dispatch without inventing file-level defects.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketVerificationDiagnostic } from "../../src/modules/supervisor/ticket-verification-diagnostic.js";
import { verifyTicketChangeset } from "../../src/modules/supervisor/ticket-verification-gate.js";
import { createSupervisorLoop } from "../../src/modules/supervisor/supervisor-loop.js";

const context = { task_id: "TASK", project_id: "PROJECT", version: 2, review_commit_sha: "COMMIT", source_revision: "REV", base_sha: "BASE", manifest_sha: "MANIFEST" };
const artifact = { ...context, artifact_id: "ARTIFACT-1", status: "failed", commit_sha: "COMMIT", commands: [{ kind: "unit", argv: ["node", "--test", "test.js"], exit_code: 1, stderr_redacted: "Expected dialog closed; token [REDACTED]", stdout_redacted: "assertion failed" }] };

// Loads only controlled immutable verification records, never invoking a real verification command.
function diagnostic(options = {}) {
  return createTicketVerificationDiagnostic({ loadContext: async () => context,
    latestJob: async () => ({ job_id: "VERIFY-1", status: "failed", artifact_id: "ARTIFACT-1", error: { code: "VERIFY_COMMAND_FAILED" } }),
    loadArtifact: async () => artifact, ...options });
}

test("failed command artifact carries identity, argv, exit code and redacted output into repair", async () => {
  const getFailureDiagnostic = diagnostic();
  const workspace = { testService: { assertPassedArtifact: async () => { throw Object.assign(new Error("No passed artifact"), { code: "VERIFY_ARTIFACT_MISMATCH" }); }, getFailureDiagnostic } };
  const result = await verifyTicketChangeset({ workspace, job: { payload: { changed_paths: ["src/dialog.js"] } } });
  assert.equal(result.repairable, true);
  assert.equal(result.verification_diagnostic.artifact_id, "ARTIFACT-1");
  assert.deepEqual(result.verification_diagnostic.commands[0], { ...artifact.commands[0], blocking: true, output_truncated: false });
  assert.deepEqual(result.failed_paths, []);
  const sent = [];
  const loop = createSupervisorLoop({ runtime: { taskId: "TASK", supervisorId: "SUP", transition: async () => {} },
    senderQueue: { enqueue: async (request) => sent.push(request) }, eventBus: { publish: async () => assert.fail("Must repair") },
    sourceRequest: async () => ({ ticket: { id: "TASK" }, payload: {} }) });
  await loop.onEvent({ type: "verification.failed", supervisor_id: "SUP", request_id: "REQ", attempt: 1, payload: result });
  assert.deepEqual(sent[0].payload.verification_diagnostic, result.verification_diagnostic);
  assert.match(sent[0].payload.text, /Expected dialog closed/);
});

test("storage, stale source and missing artifact never become blind Coder code repairs", async () => {
  for (const getFailureDiagnostic of [
    diagnostic({ latestJob: async () => ({ status: "failed", error: { code: "VERIFY_STORAGE_EXHAUSTED" } }) }),
    diagnostic({ loadArtifact: async () => ({ ...artifact, source_revision: "OLD" }) }),
    diagnostic({ latestJob: async () => null })
  ]) {
    const result = await verifyTicketChangeset({ workspace: { testService: { assertPassedArtifact: async () => { throw Object.assign(new Error("Missing pass"), { code: "VERIFY_ARTIFACT_MISMATCH" }); }, getFailureDiagnostic } }, job: { payload: {} } });
    assert.equal(result.repairable, false);
    const events = [];
    const loop = createSupervisorLoop({ runtime: { taskId: "TASK", supervisorId: "SUP", transition: async () => {} },
      senderQueue: { enqueue: async () => assert.fail("No blind repair") }, eventBus: { publish: async (event) => events.push(event) } });
    await loop.onEvent({ type: "verification.failed", supervisor_id: "SUP", request_id: "REQ", payload: result });
    assert.deepEqual(events.map((event) => event.type), ["task.failed"]);
  }
});

test("truncated diagnostics retain a durable evidence reference", async () => {
  const result = await diagnostic({ loadArtifact: async () => ({ ...artifact, commands: [{ ...artifact.commands[0], stderr_redacted: "x".repeat(10_000) }] }) })();
  assert.equal(result.commands[0].stderr_redacted.length, 8000);
  assert.equal(result.commands[0].output_truncated, true);
  assert.match(result.evidence_ref, /ARTIFACT-1.json$/);
});

// Gives Coder only the blocking assertion while Node keeps successful commands
// and complete source-bound receipts available to independent verification/review.
test("repair diagnostics omit passing commands and passing output inside a failed test command", async () => {
  const passed = { kind: "lint", exit_code: 0, stdout_redacted: "PASS-LOG" };
  const failed = { ...artifact.commands[0], test_paths: ["test.js"], scope: "ticket", criterion_ids: ["AC-1"],
    stdout_redacted: [JSON.stringify({ type: "output", text: "PASS-LOG" }),
      JSON.stringify({ type: "failure", name: "dialog closes", file: "test.js", line: 7, error: { message: "Expected closed", expected: true, actual: false } }),
      JSON.stringify({ type: "summary", failed: 1, cancelled: 0 })].join("\n") };
  const stored = { ...artifact, commands: [passed, failed] };
  const result = await diagnostic({ loadArtifact: async () => stored })();
  assert.equal(result.commands.length, 1);
  assert.deepEqual(result.commands[0].test_paths, ["test.js"]);
  assert.deepEqual(result.commands[0].criterion_ids, ["AC-1"]);
  assert.match(result.commands[0].stdout_redacted, /Expected closed/);
  assert(!JSON.stringify(result).includes("PASS-LOG"));
  assert.equal(stored.commands.length, 2);
});
