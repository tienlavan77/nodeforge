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
