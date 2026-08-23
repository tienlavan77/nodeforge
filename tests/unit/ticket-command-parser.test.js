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

test("owner chat dispatches only ready commands with the ticket id as task id", async () => {
  const { createOwnerChatService } = await import("../../src/application/owner-chat-service.js");
  const sent = [];
  const dispatched = [];
  const bus = { send: (message) => { sent.push(message); return message; }, sendFast: () => {}, flush: async () => {} };
  const chat = createOwnerChatService({ bus, ticketCommandParser: parser([{ id: "NF-1", status: "pending" }]), dispatchAgentTicket: (value) => dispatched.push(value) });
  const input = { message_id: "MSG-1", project_id: "P", conversation_id: "CONV-BU", correlation_id: "CORR-1", timestamp: "2026-08-23T10:00:00Z", agent_id: "builder", payload: { text: "/ticket NF-1" } };
  chat.submit(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched[0].task_id, "NF-1");
  assert.equal(sent[0].payload.task.id, "NF-1");
});

test("normalizes whitespace inside ticket ids", () => {
  const result = parser([{ id: "FORGE-VALIDATE-001", status: "pending" }]).parse("/ticket FORGE-\n  VALIDATE-001");
  assert.equal(result.status, "ready");
  assert.equal(result.ticket_id, "FORGE-VALIDATE-001");
});

test("malformed ticket commands return syntax errors instead of falling back", () => {
  assert.equal(parseTicketCommand("/ticket" ).status, "syntax_error");
  assert.equal(parser([]).parse("/ticket ???").status, "not_found");
});
