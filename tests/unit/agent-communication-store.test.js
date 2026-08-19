import assert from "node:assert/strict";
import test from "node:test";

import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

test("stores valid Agent Messages append-only and queries their Node-mediated parties", () => {
  const store = createAgentCommunicationStore();
  const first = message("MSG-122-1", "ARCH-1", "NODE-1", "CORR-122");
  const second = message("MSG-122-2", "NODE-1", "SPRINT-1", "CORR-122");
  const third = message("MSG-122-3", "NODE-1", "RUNTIME-1", "CORR-OTHER");
  store.append(first);
  store.append(second);
  store.append(third);
  first.payload.decision_id = "mutated";

  assert.deepEqual(store.getAll().map(({ id }) => id), ["MSG-122-1", "MSG-122-2", "MSG-122-3"]);
  assert.equal(store.getById("MSG-122-1").payload.decision_id, "DECISION-122");
  assert.deepEqual(store.getBySender("NODE-1").map(({ id }) => id), ["MSG-122-2", "MSG-122-3"]);
  assert.deepEqual(store.getByReceiver("SPRINT-1").map(({ id }) => id), ["MSG-122-2"]);
  assert.deepEqual(store.getByCorrelationId("CORR-122").map(({ id }) => id), ["MSG-122-1", "MSG-122-2"]);
});

test("rejects invalid and duplicate Agent Messages without mutating stored data", () => {
  const store = createAgentCommunicationStore();
  const valid = message("MSG-122-4", "NODE-1", "BUILDER-1");
  const invalid = message("MSG-122-invalid", "NODE-1", "BUILDER-1");
  delete invalid.timestamp;
  assert.throws(() => store.append(invalid), /Invalid Agent Message/);
  store.append(valid);
  assert.throws(() => store.append(valid), /already exists/);
  const read = store.getById("MSG-122-4");
  read.payload.decision_id = "caller mutation";
  assert.equal(store.getById("MSG-122-4").payload.decision_id, "DECISION-122");
  assert.equal(store.getAll().length, 1);
});

function message(id, senderId, recipientId, correlationId) {
  return {
    id,
    project_id: "PROJECT-122",
    sender: { id: senderId, role: roleFor(senderId) },
    recipient: { id: recipientId, role: roleFor(recipientId) },
    message_type: "governance.decision.proposed",
    payload: { decision_id: "DECISION-122" },
    ...(correlationId ? { correlation_id: correlationId } : {}),
    timestamp: "2026-08-20T08:00:00Z"
  };
}

function roleFor(id) {
  if (id.startsWith("ARCH")) return "architecture_manager";
  if (id.startsWith("SPRINT")) return "sprint_lead";
  if (id.startsWith("RUNTIME")) return "runtime";
  if (id.startsWith("BUILDER")) return "builder";
  return "node";
}
