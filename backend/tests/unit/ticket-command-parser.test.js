import assert from "node:assert/strict";
import test from "node:test";
import { createTicketCommandParser, parseTicketCommand } from "../../src/application/ticket-command-parser.js";

function parser(tickets) {
  return createTicketCommandParser({ roadmapStore: { getCurrent: () => ({ sprints: [{ tickets }] }) } });
}

test("recognizes only the exact /ticket command", () => {
  assert.deepEqual(parseTicketCommand("please /ticket NF-1"), { command: false });
  assert.deepEqual(parseTicketCommand("/ticket NF-1"), { command: true, ticket_id: "NF-1" });
});

test("returns ready when all dependencies are done", () => {
  const result = parser([{ id: "NF-1", status: "pending", dependencies: ["NF-0"] }, { id: "NF-0", status: "done" }]).parse("/ticket NF-1");
  assert.equal(result.status, "ready");
});

test("returns blocked with concrete unfinished dependencies", () => {
  const result = parser([{ id: "NF-1", status: "pending", depends_on: ["NF-0", "NF-X"] }, { id: "NF-0", status: "running" }]).parse("/ticket NF-1");
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked_by, [{ id: "NF-0", status: "running" }, { id: "NF-X", status: "not_found" }]);
});

test("distinguishes missing and already active tickets", () => {
  const service = parser([{ id: "NF-1", status: "running" }, { id: "NF-2", status: "done" }]);
  assert.equal(service.parse("/ticket NF-MISSING").status, "not_found");
  assert.equal(service.parse("/ticket NF-1").status, "running");
  assert.equal(service.parse("/ticket NF-2").status, "done");
});

test("allows retrying a failed ticket", () => {
  const result = parser([{ id: "NF-FAILED", status: "failed" }]).parse("/ticket NF-FAILED");
  assert.equal(result.status, "ready");
  assert.equal(result.ticket.id, "NF-FAILED");
});

test("owner chat forwards /ticket text without parsing or dispatching", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = []; const requests = [];
  const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const parserService = { parse: () => { throw new Error("owner chat must not parse commands"); } };
  const chat = createOwnerChatService({
    bus,
    ticketCommandParser: parserService,
    dispatchAgentTicket: () => { throw new Error("owner chat must not dispatch tickets"); },
    agentRequest: async ({ payload }) => { requests.push(payload); return { payload: { text: "ok" } }; }
  });
  const text = "/ticket NF-1";
  chat.submit({ message_id: "MSG-1", project_id: "P", conversation_id: "CONV-BU", correlation_id: "CORR-1", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].payload.text, text);
  assert.equal(sent[0].payload.intent, "normal_chat");
  assert.equal(requests[0].text, text);
});

test("owner chat forwards ticket-shaped prose and JSON as ordinary text", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = []; const requests = [];
  const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const proseTicketService = { parse: () => { throw new Error("owner chat must not parse prose"); }, createFromObject: () => { throw new Error("owner chat must not create tickets"); } };
  const chat = createOwnerChatService({ bus, proseTicketService, agentRequest: async ({ payload }) => { requests.push(payload); return { payload: { text: "ok" } }; } });
  const texts = [
    "Title: Demo\nObjective: Discuss the ticket shape",
    '{"id":"NF-1","title":"Demo","objective":"Discuss","acceptance_criteria":["Works"]}'
  ];
  texts.forEach((text, index) => chat.submit({ message_id: `MSG-TEXT-${index}`, project_id: "P", conversation_id: `CONV-${index}`, correlation_id: `CORR-${index}`, timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.filter((message) => message.message_type === "owner.message").map((message) => message.payload.text), texts);
  assert.deepEqual(requests.map((payload) => payload.text), texts);
});

test("owner chat accepts only the normal_chat intent", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = [];
  const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const chat = createOwnerChatService({ bus, agentRequest: async () => ({ payload: { text: "ok" } }) });
  chat.submit({ message_id: "MSG-INTENT-1", project_id: "P", conversation_id: "CONV-A", correlation_id: "CORR-INTENT-1", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "Technical payload: {}", intent: "normal_chat" } });
  assert.equal(sent[0].payload.intent, "normal_chat");
  assert.throws(() => chat.submit({ message_id: "MSG-INTENT-2", project_id: "P", conversation_id: "CONV-A", correlation_id: "CORR-INTENT-2", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "old ticket intent", intent: "ticket_create" } }), /Invalid owner message intent/);
});
