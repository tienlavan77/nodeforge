// Summary: Verifies owner chat intent handling after ticket dispatch moves to Ticket Run.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

test("owner chat honors explicit normal_chat intent", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = [];
  const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const chat = createOwnerChatService({ bus, proseTicketService: { parse: () => { throw new Error("must not parse normal chat"); } }, agentRequest: async () => ({ payload: { text: "ok" } }) });
  chat.submit({ message_id: "MSG-INTENT-1", project_id: "P", conversation_id: "CONV-A", correlation_id: "CORR-INTENT-1", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "Technical payload: {}", intent: "normal_chat" } });
  assert.equal(sent[0].payload.intent, "normal_chat");
});

test("legacy normal chat bypasses prose ticket parsing", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = [];
  const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const chat = createOwnerChatService({ bus, proseTicketService: { parse: () => { throw new Error("must not parse legacy normal chat"); } }, agentRequest: async () => ({ payload: { text: "ok" } }) });
  chat.submit({ message_id: "MSG-LEGACY-1", project_id: "P", conversation_id: "CONV-A", correlation_id: "CORR-LEGACY-1", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "Please discuss this JSON: {}" } });
  assert.equal(sent[0].payload.intent, "normal_chat");
});

test("returns invalid_ticket_json for malformed ticket_create JSON", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = []; const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const chat = createOwnerChatService({ bus, proseTicketService: { parse: () => { throw new Error("must not parse malformed JSON"); } } });
  chat.submit({ message_id: "MSG-BAD-JSON", project_id: "P", conversation_id: "C", correlation_id: "R", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { intent: "ticket_create", text: '{"title":"Demo","objective":"line one\nline two","acceptance_criteria":["Works"]}' } });
  assert.equal(sent[0].payload.error_code, "invalid_ticket_json");
});

test("ticket object takes precedence over malformed ticket text", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = []; const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const ticket = { id: "T-OBJECT", project_id: "P", roadmap_id: "R", sprint_id: "S", title: "Demo", objective: "Run", acceptance_criteria: ["Works"], provenance: { source: "project_owner", source_id: "T-OBJECT", created_at: "2026-08-23T10:00:00Z" } };
  const chat = createOwnerChatService({ bus, proseTicketService: { createFromObject: (value) => ({ create_ticket: true, status: "created", ticket: value }), parse: () => { throw new Error("text must be ignored"); } } });
  chat.submit({ message_id: "MSG-OBJECT", project_id: "P", conversation_id: "C", correlation_id: "R", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { intent: "ticket_create", ticket, text: '{"objective":"broken\nvalue"}' } });
  assert.equal(sent[0].payload.status, "created");
  assert.equal(sent[0].payload.ticket.id, "T-OBJECT");
});

test("retired ticket command stays plain chat and never dispatches a ticket", () => {
  const sent = [];
  const bus = { send: (message) => { sent.push(message); return message; } };
  const chat = createOwnerChatService({ bus });
  chat.submit({ message_id: "MSG-OLD-COMMAND", project_id: "P", conversation_id: "CONV-A", correlation_id: "CORR-OLD", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "/ticket NF-1" } });
  assert.equal(sent[0].payload.intent, "normal_chat");
  assert.equal(sent[0].payload.task, undefined);
  assert.equal(sent[1].payload.error_code, "BUILDER_TICKET_REQUIRED");
});

test("retired ticket dispatch intent is rejected", () => {
  const bus = { send: (message) => message };
  const chat = createOwnerChatService({ bus });
  assert.throws(() => chat.submit({ message_id: "MSG-OLD-INTENT", project_id: "P", conversation_id: "CONV-A", correlation_id: "CORR-OLD", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "NF-1", intent: "ticket_dispatch" } }), /Invalid owner message intent/);
});

test("chat persistence uses message refs across service restarts and pairs each response", async () => {
  const refs = [];
  const bus = { send: (message) => message };
  const protocolStorage = { save: async (ref) => { refs.push(ref); } };
  const agentRequest = async () => ({ payload: { text: "ok" } });
  // Builds a chat message for checking persistent refs after a service restart.
  const input = (messageId) => ({ message_id: messageId, project_id: "P", conversation_id: "CONV-A", correlation_id: messageId, timestamp: "2026-08-23T10:00:00Z", agent_id: "architecture-manager", payload: { text: "hello", intent: "normal_chat" } });
  createOwnerChatService({ bus, protocolStorage, agentRequest }).submit(input("MSG-FIRST"));
  createOwnerChatService({ bus, protocolStorage, agentRequest }).submit(input("MSG-SECOND"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refs.sort(), [
    "task/MSG-FIRST/round_1/request", "task/MSG-FIRST/round_1/response",
    "task/MSG-SECOND/round_1/request", "task/MSG-SECOND/round_1/response"
  ]);
});
