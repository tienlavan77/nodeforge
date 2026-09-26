import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

const input = (id, text) => ({ message_id: id, project_id: "P", conversation_id: "CONV-BU-P-T", correlation_id: id, timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text } });
function setup() {
  const internalBus = new EventEmitter(); const sent = []; const requests = [];
  const bus = { send: (value) => { sent.push(value); return value; }, sendFast: () => {}, flush: async () => {} };
  const service = createOwnerChatService({ bus, internalBus, agentRequest: async (value) => { requests.push(value); return { payload: { text: "ok" } }; } });
  return { internalBus, sent, requests, service };
}

test("rejects input while running and reopens on done", async () => {
  const { internalBus, sent, requests, service } = setup();
  service.submit(input("M1", "/ticket T")); await new Promise((resolve) => setImmediate(resolve));
  internalBus.emit("node.status_change", { task_id: "T", payload: { conversation_id: "CONV-BU-P-T", to: "running" } });
  const rejected = service.submit(input("M2", "follow up"));
  assert.equal(rejected.message_type, "ticket.input_rejected"); assert.equal(requests.length, 1);
  internalBus.emit("node.status_change", { task_id: "T", payload: { conversation_id: "CONV-BU-P-T", to: "done" } });
  service.submit(input("M3", "follow up")); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((message) => message.message_type === "owner.message").at(-1).payload.round, 2);
  assert.equal(requests.length, 2);
});

test("ticket commands stay ordinary chat while the conversation is unlocked", async () => {
  const { requests, service } = setup();
  service.submit(input("M-RACE", "/ticket T")); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.text, "/ticket T");
});
