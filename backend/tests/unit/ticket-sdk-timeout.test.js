// Verifies local SDK deadlines become visible, manually resumable ticket failures.
// Exercises real launch/checkpoint storage while preventing duplicate provider execution.
import assert from "node:assert/strict";
import test from "node:test";
import { coderProductionRecoveryFixture, TICKET } from "../fixtures/coder-production-recovery-fixture.js";
import { confirmTicketSdkTimeout } from "../../src/modules/supervisor/ticket-sdk-timeout.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

// Creates the typed gateway failure without relying on an agent's narrative response.
function timeout() {
  return Object.assign(new Error("Codex SDK request timed out for CODER."), { code: "SDK_REQUEST_TIMEOUT", provider_outcome: "unknown", retry_safe: false });
}

test("a settled timeout fails visibly and explicit Resume continues the same checkpoint and thread", async () => {
  const f = await coderProductionRecoveryFixture({ assertSessionStopped: () => {}, behavior: async ({ onSessionReady, onEvent, resumeThreadId, prompt }, invocation) => {
    if (invocation === 1) {
      onSessionReady("THREAD-TIMEOUT");
      await onEvent({ type: "item.completed", item: { id: "read", type: "mcp_tool_call", server: "forge", tool: "git_status", status: "completed" } });
      throw timeout();
    }
    assert.equal(resumeThreadId, "THREAD-TIMEOUT");
    assert.match(prompt, /previous execution stopped after completing turn 125/);
    await onEvent({ type: "item.completed", item: { id: "report", type: "mcp_tool_call", server: "forge", tool: "report_done", status: "completed" } });
    return { text: "Reported" };
  } });
  try {
    assert.equal((await f.run({ task_id: "TASK", status: "in_progress", thread_id: "THREAD-TIMEOUT", last_completed_turn: 125,
      changed_paths: ["backend/src/handler.js"], completed_tools: ["write_diff", "commit_changes"] })).status, "failed");
    const checkpoint = await f.checkpoints.load("TASK");
    assert.equal(checkpoint.status, "failed");
    assert.equal(checkpoint.phase, "sdk_timeout");
    assert.equal(checkpoint.failure.resume_allowed, true);
    assert.equal(checkpoint.last_completed_turn, 125);
    assert.deepEqual(checkpoint.changed_paths, ["backend/src/handler.js"]);
    assert.equal(f.statusStore.get().status, "failed");
    assert.equal(f.statusStore.get().details.launch_claim, undefined);
    assert.equal(f.occupancy.getByTask(), null);
    assert.equal(f.events.at(-1).payload.reason, "SDK_REQUEST_TIMEOUT");
    f.advance(60_000); await f.restart().tick();
    assert.equal(f.invocations, 1, "Timeout must wait for the user's Resume");
    f.statusStore.resumeReviewExecution = f.statusStore.resumeBlockedExecution;
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: TICKET }) },
      sprintRegistry: f.registry, ticketStatusStore: f.statusStore, checkpoints: f.checkpoints, queueStore: f.store,
      dispatchTask: ({ ticket, executionId, sprintBasis, dependencyExpectations, resume_from, message }) => f.service.runTicket({ ticket, task_id: ticket.id,
        project_id: "P", request_id: message.id, correlation_id: message.correlation_id,
        payload: { execution_id: executionId, sprint_basis: sprintBasis, dependency_expectations: dependencyExpectations, resume_from } }) });
    assert.equal((await dispatch({ projectId: "P", ticketId: "TASK" })).resumed_from_turn, 125);
    assert.equal(f.invocations, 2);
    assert.equal(f.statusStore.get().status, "done");
  } finally { await f.close(); }
});

test("an active or unverifiable runner retains the original launch and cannot auto-retry", async () => {
  const f = await coderProductionRecoveryFixture({ assertSessionStopped: () => { throw Object.assign(new Error("Still running"), { code: "EXECUTION_SESSION_BUSY" }); },
    behavior: async () => { throw timeout(); } });
  try {
    await assert.rejects(f.run(), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
    assert.ok(f.statusStore.get().details.launch_claim);
    assert.equal(f.events.length, 0);
    f.advance(60_000); await f.restart().tick();
    assert.equal(f.invocations, 1);
  } finally { await f.close(); }
});

test("only the exact legacy gateway timeout qualifies; agent prose and foreign checkpoints do not", async () => {
  let probes = 0;
  const checkpoint = { task_id: "TASK", status: "blocked", provider: "codex", agent_id: "CODER" };
  const input = { checkpoint, selected: { provider: "codex", agent_id: "CODER" }, gateway: { assertSessionStopped: () => { probes++; } } };
  for (const error of [new Error("SDK_REQUEST_TIMEOUT"), { code: "CODER_BLOCKED", message: "Codex SDK request timed out for CODER." },
    { code: "CONFIGURATION_ERROR", message: "Earlier Codex SDK request timed out for CODER." }]) {
    assert.equal(await confirmTicketSdkTimeout({ ...input, error }), false);
  }
  assert.equal(await confirmTicketSdkTimeout({ ...input, checkpoint: { ...checkpoint, agent_id: "OTHER" }, error: timeout() }), false);
  assert.equal(probes, 0);
  const error = Object.assign(new Error("Codex SDK request timed out for CODER."), { code: "CONFIGURATION_ERROR" });
  assert.equal(await confirmTicketSdkTimeout({ ...input, error }), true);
  assert.equal(error.resume_allowed, true);
  assert.equal(error.retry_safe, false);
});
