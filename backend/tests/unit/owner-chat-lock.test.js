import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

const input = (id, text) => ({ message_id: id, project_id: "P", conversation_id: "CONV-BU-P-T", correlation_id: id, timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text } });
function setup() {
  const internalBus = new EventEmitter(); const sent = []; const dispatched = [];
  const bus = { send: (value) => { sent.push(value); return value; }, sendFast: () => {}, flush: async () => {} };
  const parser = { parse: (text) => text.startsWith("/ticket") ? { command: true, ticket_id: "T", status: "ready", ticket: { id: "T", title: "T", objective: "Do T" } } : { command: false } };
  const service = createOwnerChatService({ bus, internalBus, ticketCommandParser: parser, dispatchAgentTicket: (value) => dispatched.push(value) });
  return { internalBus, sent, dispatched, service };
}

test("rejects input while running and reopens on done", async () => {
  const { internalBus, sent, dispatched, service } = setup();
  service.submit(input("M1", "/ticket T")); await new Promise((resolve) => setImmediate(resolve));
  internalBus.emit("node.status_change", { task_id: "T", payload: { conversation_id: "CONV-BU-P-T", to: "running" } });
  const rejected = service.submit(input("M2", "follow up"));
  assert.equal(rejected.message_type, "ticket.input_rejected"); assert.equal(dispatched.length, 1);
  internalBus.emit("node.status_change", { task_id: "T", payload: { conversation_id: "CONV-BU-P-T", to: "done" } });
  service.submit(input("M3", "follow up"));
  assert.equal(sent.at(-1).payload.round, 2);
});

test("race between status and send never dispatches while locked", () => {
  const { internalBus, dispatched, service } = setup();
  internalBus.emit("node.status_change", { task_id: "T", payload: { conversation_id: "CONV-BU-P-T", to: "running" } });
  const result = service.submit(input("M-RACE", "/ticket T"));
  assert.equal(result.message_type, "ticket.input_rejected"); assert.equal(dispatched.length, 0);
});
