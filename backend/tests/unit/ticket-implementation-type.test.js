// Verifies new ticket execution types and presentation metadata without accepting ambiguous SL output.
import assert from "node:assert/strict";
import test from "node:test";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createProseTicketService } from "../../src/application/prose-ticket-service.js";
import { createTicketCrudService } from "../../src/application/ticket-crud-service.js";

// Builds one owner ticket with the stable fields needed to exercise ticket validation.
function ticket(overrides = {}) {
  return { title: "Refine sidebar", objective: "Make sidebar controls usable.", acceptance_criteria: ["Controls work."], ...overrides };
}

test("ticket schema accepts one implementation_type and rejects mixed or legacy fields together", async () => {
  const roadmaps = createRoadmapStore();
  const service = createTicketCrudService({ roadmaps, proseTicketService: createProseTicketService({ roadmapStore: roadmaps }) });
  const created = await service.createTicket({ projectId: "P1", ticket: ticket({ implementation_type: ["frontend"], change_nature: "presentation-only" }) });
  assert.deepEqual(created.ticket.implementation_type, ["frontend"]);
  assert.equal(created.ticket.style, undefined);
  const testOnly = await service.createTicket({ projectId: "P1", ticket: ticket({ implementation_type: ["frontend"], change_nature: "test-only" }) });
  assert.equal(testOnly.ticket.change_nature, "test-only");
  for (const invalid of [
    { id: "BAD-MIXED", implementation_type: ["frontend", "backend"] },
    { id: "BAD-INFRA", implementation_type: ["infra"] },
    { id: "BAD-BOTH", implementation_type: ["backend"], style: ["backend"] },
    { id: "BAD-NATURE", implementation_type: ["backend"], change_nature: "presentation-only" },
    { id: "BAD-UNKNOWN", implementation_type: ["frontend"], change_nature: "implementation" }
  ]) await assert.rejects(() => service.createTicket({ projectId: "P1", ticket: ticket(invalid) }), { code: "INVALID_TICKET" });
});
