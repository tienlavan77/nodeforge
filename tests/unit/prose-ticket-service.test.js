import assert from "node:assert/strict";
import test from "node:test";

import { createProseTicketService, nextVersion } from "../../src/application/prose-ticket-service.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";

test("creates and persists a valid ticket from structured owner prose", () => {
  const store = createRoadmapStore();
  const service = createProseTicketService({ roadmapStore: store, clock: () => new Date("2026-08-23T00:00:00Z") });
  const result = service.parse("Ticket: Add dashboard\nTitle: Add dashboard\nObjective: Show project status\nAcceptance Criteria: UI renders status; tests cover loading\nPriority: high", { projectId: "PROJECT-CHAT", sourceId: "MSG-CHAT-1" });
  assert.equal(result.status, "created");
  assert.equal(store.getCurrent().sprints[0].tickets[0].id, result.ticket.id);
  assert.equal(result.ticket.priority, "high");
});

test("returns missing fields without persisting", () => {
  const store = createRoadmapStore();
  const service = createProseTicketService({ roadmapStore: store });
  const result = service.parse("Please create a ticket for the dashboard", { projectId: "PROJECT-CHAT" });
  assert.equal(result.status, "needs_input");
  assert.ok(result.missing.includes("title"));
  assert.equal(store.getCurrent(), undefined);
});

test("new ticket is discoverable by the ticket command parser", async () => {
  const store = createRoadmapStore();
  const service = createProseTicketService({ roadmapStore: store });
  const result = service.parse("Ticket: Add tests\nTitle: Add tests\nObjective: Cover parser\nAcceptance Criteria: Unit test passes", { projectId: "PROJECT-CHAT" });
  const { createTicketCommandParser } = await import("../../src/application/ticket-command-parser.js");
  const parsed = createTicketCommandParser({ roadmapStore: store }).parse(`/ticket ${result.ticket.id}`);
  assert.equal(parsed.status, "ready");
});

test("valid ticket JSON is validated directly and persisted", () => {
  const store = createRoadmapStore();
  const service = createProseTicketService({ roadmapStore: store });
  const ticket = { id: "TICKET-JSON-1", project_id: "PROJECT-CHAT", roadmap_id: "ROADMAP-PROJECT-CHAT", sprint_id: "SPRINT-PROJECT-CHAT", title: "JSON ticket", objective: "Use structured input", acceptance_criteria: ["Persist ticket"], priority: "normal", provenance: { source: "project_owner", source_id: "MSG-JSON-1", created_at: "2026-08-23T00:00:00Z" } };
  const result = service.parse(JSON.stringify(ticket));
  assert.equal(result.status, "created");
  assert.equal(store.getCurrent().sprints[0].tickets[0].id, ticket.id);
});

test("structured JSON with missing fields reports exact omissions and does not persist", () => {
  const store = createRoadmapStore();
  const service = createProseTicketService({ roadmapStore: store });
  const result = service.parse(JSON.stringify({ id: "TICKET-JSON-2", title: "Incomplete" }));
  assert.equal(result.status, "needs_input");
  assert.ok(result.missing.includes("project_id"));
  assert.ok(result.missing.includes("acceptance_criteria"));
  assert.equal(store.getCurrent(), undefined);
});

test("increments semantic versions after status suffixes", () => {
  assert.equal(nextVersion("1.0.1"), "1.0.2");
  assert.equal(nextVersion("1.0.1-status-123-status-456"), "1.0.2");
});

test("persists a new ticket after a status-versioned roadmap", () => {
  const store = createRoadmapStore();
  const service = createProseTicketService({ roadmapStore: store });
  service.parse(JSON.stringify(ticket("TICKET-VERSION-1")));
  const base = store.getCurrent();
  store.save({ ...base, version: "1.0.1" });
  store.save({ ...store.getCurrent(), version: "1.0.1-status-123-status-456" });
  const result = service.parse(JSON.stringify(ticket("TICKET-VERSION-2")));
  assert.equal(result.status, "created");
  assert.equal(result.roadmap.version, "1.0.2");
});

function ticket(id) {
  return { id, project_id: "PROJECT-CHAT", roadmap_id: "ROADMAP-PROJECT-CHAT", sprint_id: "SPRINT-PROJECT-CHAT", title: id, objective: "Use structured input", acceptance_criteria: ["Persist ticket"], priority: "normal", provenance: { source: "project_owner", source_id: id, created_at: "2026-08-23T00:00:00Z" } };
}
