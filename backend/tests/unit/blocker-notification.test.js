// Verifies blocked execution notifications explain the actual denial and retain resumable evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerNotification } from "../../src/modules/supervisor/blocker-notification.js";

// Captures terminal, event and checkpoint output without launching or authorizing an agent.
async function notify(job) {
  const logs = [], events = [], saved = [];
  const checkpoint = { task_id: "T", status: "blocked", turn: 97 };
  const publish = createBlockerNotification({
    inspect: async () => ({ checkpoint, current: { status: "needs_human_review", details: {} } }),
    checkpoints: { load: async () => checkpoint, save: async (value) => { saved.push(value); return value; } },
    eventBus: { publish: async (value) => { events.push(value); } },
    projectLogger: (value) => { logs.push(value); }, clock: () => 0,
  });
  await publish({ id: "J", stage: "sprint_leader", outcome_reason: "technical_reconciliation_waiting_for_evidence",
    request: { task_id: "T", project_id: "P", payload: { execution_id: "E" } }, ...job });
  return { log: logs[0], event: events[0], checkpoint: saved.at(-1) };
}

test("retained denial explains the original service failure and pending evidence without advertising the removed endpoint", async () => {
  const waiting = [{ owner: "external", question: "Explicit authorization for the denied fixture creation." }, "Approval provider recovery."];
  const admission = { endpoint: "/removed/blocker-admission", sha256: "abc", receipts: [
    { event_id: "DENIAL", error: { message: "This action was rejected.\nReason: 503 system cpu overloaded\nDo not retry without authorization." } },
  ] };
  const result = await notify({ execution_admission: admission, technical_reconciliation: { work: { waiting_for: waiting } } });
  assert.match(result.log.message, /Execution stopped/);
  assert.match(result.log.message, /DENIAL:.*503 system cpu overloaded/);
  assert.match(result.log.message, /external: Explicit authorization/);
  assert.match(result.log.message, /RUN alone does not clear this denial/);
  assert.doesNotMatch(result.log.message, /RUN can resume|Optional review|\/removed/);
  assert.doesNotMatch(JSON.stringify(result.event.payload.proposal), /\/removed/);
  assert.deepEqual(result.event.payload.waiting_for, waiting);
  assert.deepEqual(result.checkpoint.blocker_recovery.waiting_for, waiting);
  assert.deepEqual(result.checkpoint.blocker_recovery.execution_admission, admission);
  assert.equal(result.checkpoint.turn, 97);
  assert.equal(result.log.status, "blocked");
});

test("legacy denial without receipts reports its retained error and does not imply RUN clears it", async () => {
  const result = await notify({ execution_admission: { sha256: "abc" }, last_error: "Tool authorization unavailable." });
  assert.match(result.log.message, /Tool authorization unavailable/);
  assert.match(result.log.message, /permitted resolution of the original tool denial/);
  assert.doesNotMatch(result.log.message, /undefined|Optional review|RUN can resume/);
});

test("ordinary reconciliation preserves the agent proposal without inventing an execution denial", async () => {
  const proposal = { title: "Missing source", options: [{ id: "inspect", description: "Inspect the source." }] };
  const result = await notify({ resolution: { proposal }, last_error: "Source unavailable." });
  assert.deepEqual(result.event.payload.proposal, proposal);
  assert.match(result.log.message, /Source unavailable/);
  assert.doesNotMatch(result.log.message, /Execution stopped|denial/);
});
