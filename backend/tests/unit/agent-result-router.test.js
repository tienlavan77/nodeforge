import assert from "node:assert/strict";
import test from "node:test";

import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createAgentResultRouter } from "../../src/modules/agent/agent-result-router.js";

test("routes supported results by type and correlation after auditing", () => {
  const communication = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communication });
  const calls = [];
  const router = createAgentResultRouter({ bus });
  router.registerWorkflow("CORR-132", {
    "architecture.completed": (message) => calls.push([message.message_type, message.correlation_id]),
    "sprint.plan.completed": (message) => calls.push([message.message_type, message.correlation_id]),
    "ticket.completed": (message) => calls.push([message.message_type, message.correlation_id]),
    "review.completed": (message) => calls.push([message.message_type, message.correlation_id]),
    "agent.failed": (message) => calls.push([message.message_type, message.correlation_id])
  });
  for (const [index, type] of ["architecture.completed", "sprint.plan.completed", "ticket.completed", "review.completed", "agent.failed"].entries()) bus.send(message(`RESULT-132-${index}`, type, "CORR-132"));

  assert.deepEqual(calls, [
    ["architecture.completed", "CORR-132"], ["sprint.plan.completed", "CORR-132"], ["ticket.completed", "CORR-132"], ["review.completed", "CORR-132"], ["agent.failed", "CORR-132"]
  ]);
  assert.equal(router.getAudit().length, 5);
  assert.equal(communication.getAll().length, 5);
});

test("is idempotent, rejects unknown routes, and does not mutate messages", () => {
  const bus = createAgentCommunicationBus({ store: createAgentCommunicationStore() });
  let executions = 0;
  const router = createAgentResultRouter({ bus });
  router.registerWorkflow("CORR-132-2", { "ticket.completed": () => { executions += 1; } });
  const result = message("RESULT-132-DUP", "ticket.completed");
  const first = router.route(result);
  const duplicate = router.route(result);
  result.payload.changed = true;

  assert.equal(first.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
  assert.equal(router.getAudit()[0].payload.changed, undefined);
  assert.throws(() => router.route(message("RESULT-132-UNKNOWN", "unknown.type")), /Unknown or invalid/);
  assert.throws(() => router.route(message("RESULT-132-UNROUTED", "review.completed")), /No workflow route/);
});

function message(id, type, correlationId = "CORR-132-2") {
  return { id, project_id: "PROJECT-132", correlation_id: correlationId, message_type: type, sender: { id: "AGENT-132", role: "runtime" }, recipient: { id: "NODE", role: "node" }, payload: { result: "ok" }, timestamp: "2026-08-20T17:00:00Z" };
}
