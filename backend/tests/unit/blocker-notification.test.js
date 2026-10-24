// Verifies blocked execution notifications explain the actual denial and retain resumable evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerNotification } from "../../src/modules/supervisor/blocker-notification.js";
import { createExecutionEventBus } from "../../src/modules/supervisor/execution-event-bus.js";

// Captures terminal, event and checkpoint output without launching or authorizing an agent.
async function notify(job) {
  const logs = [], events = [], saved = [];
  const checkpoint = { task_id: "T", status: "blocked", turn: 97 };
  const bus = createExecutionEventBus({ validate: (event) => {
    assert.equal(event.supervisor_id, "SUP-T"); assert.equal(event.request_id, "REQ-T");
    assert.equal(event.correlation_id, "CORR-T"); assert.equal(event.attempt, 1);
    return true;
  } });
  bus.subscribe("*", async (event) => { events.push(event); });
  const publish = createBlockerNotification({
    inspect: async () => ({ checkpoint, current: { status: "needs_human_review", details: {} } }),
    checkpoints: { load: async () => checkpoint, save: async (value) => { saved.push(value); return value; } },
    eventBus: bus,
    projectLogger: (value) => { logs.push(value); }, clock: () => 0,
  });
  await publish({ id: "J", stage: "sprint_leader", outcome_reason: "technical_reconciliation_waiting_for_evidence",
    request: { task_id: "T", project_id: "P", supervisor_id: "SUP-T", request_id: "REQ-T", correlation_id: "CORR-T", payload: { execution_id: "E" } }, ...job });
  return { log: logs[0], event: events[0], events, checkpoint: saved.at(-1) };
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

/** Ensures the terminal and durable UI event carry the actual question while
 * owner_required remains reserved for an AM policy decision. */
test("technical Owner input publishes its disclosed question without creating an owner escalation", async () => {
  const ownerRequest = { kind: "tool_authorization", question: "Approve the disclosed narrow operation?", context: "The tool requires a direct answer after the denial." };
  const waiting = [{ owner: "external", question: "Obtain the direct answer." }];
  const result = await notify({ resolution: { action: "reconciliation_required", guidance: "Disclose the operation.", reconciliation: { owner_request: ownerRequest } },
    technical_reconciliation: { work: { waiting_for: waiting } } });
  assert.match(result.log.message, /External response required.*Approve the disclosed narrow operation/);
  assert.equal(result.event.type, "task.blocker.reconciliation_required");
  assert.equal(result.event.payload.owner_input_request.context, ownerRequest.context);
  assert.deepEqual(result.checkpoint.blocker_recovery.owner_request, ownerRequest);
  assert.equal(result.checkpoint.blocker_recovery.escalation, null);
  assert(result.events.some((event) => event.type === "ticket.updated" && event.payload.reason === "blocker_owner_input_required"));
});

test("current source failure is reported separately from a historical tool denial", async () => {
  const admission = { receipts: [{ event_id: "OLD-DENIAL", error: { message: "This action was rejected due to unacceptable risk." } }] };
  const result = await notify({ outcome_reason: "TICKET_SOURCE_CHANGED", execution_admission: admission,
    validation_feedback: [{ reason: "TICKET_SOURCE_CHANGED", message: "Root source changed: backend/source.js" }] });
  assert.match(result.log.message, /TICKET_SOURCE_CHANGED.*backend\/source.js/);
  assert.doesNotMatch(result.log.message, /OLD-DENIAL|unacceptable risk|RUN alone|Execution stopped/);
  assert.doesNotMatch(JSON.stringify(result.event.payload.proposal), /OLD-DENIAL|unacceptable risk/);
  assert.deepEqual(result.event.payload.execution_admission, admission);
  assert.equal(result.checkpoint.turn, 97);
});
