import assert from "node:assert/strict";
import test from "node:test";

import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createProseTicketService } from "../../src/application/prose-ticket-service.js";
import { createTicketCrudService } from "../../src/application/ticket-crud-service.js";

function createService({ agentStream, agentRoleResolver, candidateResolver, sprintLeader } = {}) {
  const roadmaps = createRoadmapStore({});
  const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
  const service = createTicketCrudService({ roadmaps, proseTicketService, agentStream, agentRoleResolver, candidateResolver, sprintLeader });
  return { roadmaps, service };
}

function ticketPatch(overrides = {}) {
  return {
    title: "Add ticket CRUD API",
    objective: "Expose ticket CRUD over /forge/v1/tickets.",
    acceptance_criteria: ["List, create, read, update, delete all work."],
    ...overrides
  };
}

test("creates a ticket into the last sprint of an existing roadmap", async () => {
  const { roadmaps, service } = createService();
  roadmaps.save({ id: "ROADMAP-P1", project_id: "P1", version: "1.0.0", created_at: "2026-09-13T00:00:00Z", sprints: [{ id: "SPRINT-P1-1", roadmap_id: "ROADMAP-P1", project_id: "P1", objective: "Sprint one", tickets: [{ id: "TICKET-SEED", project_id: "P1", roadmap_id: "ROADMAP-P1", sprint_id: "SPRINT-P1-1", title: "Seed", objective: "Seed ticket.", acceptance_criteria: ["Seed."], provenance: { source: "project_owner", source_id: "TICKET-SEED", created_at: "2026-09-13T00:00:00Z" } }], exit_criteria: ["done"] }] });
  const result = await service.createTicket({ projectId: "P1", ticket: ticketPatch() });
  assert.equal(result.created, true);
  assert.equal(result.ticket.project_id, "P1");
  assert.equal(result.ticket.sprint_id, "SPRINT-P1-1");
  assert.match(result.ticket.id, /^TICKET-P1-\d+$/);
  assert.equal(result.ticket.provenance.source, "project_owner");
  assert.equal(result.ticket.roadmap_id, "ROADMAP-P1");
  assert.equal(roadmaps.getCurrent().sprints.find((sprint) => sprint.id === "SPRINT-P1-1").tickets.length, 2);
});

test("bootstraps a roadmap when none exists and rejects duplicate ids with invalid tickets", async () => {
  const { roadmaps, service } = createService();
  const result = await service.createTicket({ projectId: "P1", ticket: { id: "TICKET-X", ...ticketPatch() } });
  assert.equal(result.created, true);
  assert.equal(result.ticket.id, "TICKET-X");
  assert.equal(result.ticket.roadmap_id, "ROADMAP-P1");
  assert.equal(result.ticket.sprint_id, "SPRINT-P1-API");
  const roadmap = roadmaps.getCurrent();
  assert.equal(roadmap.project_id, "P1");
  assert.equal(roadmap.sprints[0].id, "SPRINT-P1-API");
  await assert.rejects(() => service.createTicket({ projectId: "P1", ticket: { id: "TICKET-X", ...ticketPatch() } }), (error) => error.statusCode === 409);
});

test("lists tickets scoped to the project", () => {
  const { service } = createService();
  assert.deepEqual(service.listTickets({ projectId: "P1" }), []);
  service.createTicket({ projectId: "P1", ticket: ticketPatch() });
  const listed = service.listTickets({ projectId: "P1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].project_id, "P1");
  assert.deepEqual(service.listTickets({ projectId: "P2" }), []);
  assert.throws(() => service.listTickets({}), (error) => error.statusCode === 400);
});

test("updates ticket fields in a new roadmap version and preserves identity fields", () => {
  const { roadmaps, service } = createService();
  service.createTicket({ projectId: "P1", ticket: { id: "TICKET-U", priority: "low", ...ticketPatch() } });
  const before = roadmaps.getCurrent().version;
  const result = service.updateTicket({ projectId: "P1", ticketId: "TICKET-U", patch: { title: "Renamed", priority: "high", id: "HACK", project_id: "P2", sprint_id: "NOPE", provenance: { source: "sprint_plan" } } });
  assert.equal(result.updated, true);
  assert.equal(result.ticket.title, "Renamed");
  assert.equal(result.ticket.priority, "high");
  assert.equal(result.ticket.id, "TICKET-U");
  assert.equal(result.ticket.project_id, "P1");
  assert.notEqual(result.ticket.provenance, undefined);
  assert.notEqual(result.roadmap_version, before);
  assert.match(result.roadmap_version, /-update-/);
  assert.equal(roadmaps.getCurrent().sprints.flatMap((sprint) => sprint.tickets)[0].title, "Renamed");
});

test("update rejects empty patches and unknown tickets", () => {
  const { service } = createService();
  service.createTicket({ projectId: "P1", ticket: ticketPatch() });
  assert.throws(() => service.updateTicket({ projectId: "P1", ticketId: "NOPE", patch: { title: "X" } }), (error) => error.statusCode === 404);
  assert.throws(() => service.updateTicket({ projectId: "P1", ticketId: "TICKET-1", patch: { description: "not assignable" } }), (error) => /No updatable ticket fields/.test(error.message));
});

test("update rejects patches that would invalidate the ticket", () => {
  const { service } = createService();
  service.createTicket({ projectId: "P1", ticket: ticketPatch() });
  const ticketId = service.listTickets({ projectId: "P1" })[0].id;
  assert.throws(() => service.updateTicket({ projectId: "P1", ticketId, patch: { priority: "urgent" } }), (error) => /Invalid Ticket/.test(error.message));
  assert.throws(() => service.updateTicket({ projectId: "P1", ticketId, patch: { acceptance_criteria: [] } }), (error) => /Invalid Ticket/.test(error.message));
});

test("project mismatch and missing project are rejected", async () => {
  const { service } = createService();
  await service.createTicket({ projectId: "P1", ticket: ticketPatch() });
  assert.throws(() => service.updateTicket({ projectId: "P2", ticketId: service.listTickets({ projectId: "P1" })[0].id, patch: { title: "X" } }), (error) => error.statusCode === 404);
  await assert.rejects(() => service.createTicket({ ticket: ticketPatch() }), (error) => error.statusCode === 400);
});

test("structured tickets are created immediately without calling the sprint leader", async () => {
  let agentCalls = 0;
  const { service } = createService({
    agentStream: async function* () { agentCalls += 1; yield { text: "{}" }; },
    agentRoleResolver: { resolve: () => { throw new Error("must not resolve"); } }
  });
  const result = await service.createTicket({ projectId: "P1", ticket: ticketPatch() });
  assert.equal(result.created, true);
  assert.equal(agentCalls, 0);
});

test("invalid structured tickets keep the 422 validation error when no agent wiring exists", async () => {
  const { service } = createService();
  await assert.rejects(() => service.createTicket({ projectId: "P1", ticket: { title: "No criteria" } }), (error) => error.statusCode === 422 && error.code === "INVALID_TICKET" && /missing: objective, acceptance_criteria/.test(error.message));
});

test("raw chat content is converted by the sprint leader into a valid ticket", async () => {
  const requests = [];
  const { roadmaps, service } = createService({
    agentStream: async function* ({ agentId, payload }) {
      requests.push({ agentId, text: payload.text });
      yield { text: 'Here you go:\n```json\n{"title":"Fix login bug","objective":"Users cannot log in with expired sessions.","acceptance_criteria":["Expired sessions redirect to login."],"priority":"high"}\n```' };
    },    agentRoleResolver: { resolve: (role) => { assert.equal(role, "sprint_leader"); return "AGENT-SL-1"; } }
  });
  const result = await service.createTicket({ projectId: "P1", content: "login bị lỗi, fix giúp" });
  assert.equal(result.created, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agentId, "AGENT-SL-1");
  assert.match(requests[0].text, /login bị lỗi/);
  assert.match(requests[0].text, /in English/);
  assert.equal(result.ticket.title, "Fix login bug");
  assert.equal(result.ticket.priority, "high");
  assert.equal(result.ticket.project_id, "P1");
  assert.equal(result.ticket.sprint_id, "SPRINT-P1-API");
  assert.equal(result.ticket.provenance.source, "project_owner");
  assert.equal(roadmaps.getCurrent().sprints[0].tickets.length, 1);
});

test("private context is normalized by the sprint leader but excluded from canonical ticket persistence", async () => {
  const received = [];
  const { service } = createService({
    agentStream: async function* ({ payload }) {
      received.push(payload.text);
      yield { text: '```json\n{"title":"Add Google sign-in","objective":"Allow users to authenticate with Google.","acceptance_criteria":["Users can sign in with Google."]}\n```' };
    },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" }
  });
  const context = "Thêm đăng nhập Google.";
  const result = await service.createTicket({ projectId: "P1", context, content: context });
  assert.equal(result.created, true);
  assert.match(received[0], /Thêm đăng nhập Google/);
  assert.equal("context" in result.ticket, false);
});

test("invalid sprint leader output leaves the roadmap untouched and returns 422", async () => {
  const { roadmaps, service } = createService({
    agentStream: async function* () { yield { text: "I cannot produce a ticket for this request, sorry." }; },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" }
  });
  await assert.rejects(() => service.createTicket({ projectId: "P1", content: "việc gì đó mơ hồ" }), (error) => error.statusCode === 422 && error.code === "INVALID_TICKET" && /Sprint leader response did not contain a valid ticket/.test(error.message));
  assert.equal(roadmaps.getCurrent(), undefined);
});

test("sprint leader output that still fails validation surfaces its errors", async () => {
  const { roadmaps, service } = createService({
    agentStream: async function* () { yield { text: '```json\n{"title":"Half ticket","objective":"Missing criteria."}\n```' }; },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" }
  });
  await assert.rejects(() => service.createTicket({ projectId: "P1", content: "làm giúp cái half ticket" }), (error) => error.statusCode === 422 && error.code === "INVALID_TICKET" && /Sprint leader returned an invalid ticket/.test(error.message) && Array.isArray(error.missing));
  assert.equal(roadmaps.getCurrent(), undefined);
});

test("prose content that parses directly never reaches the sprint leader", async () => {
  let agentCalls = 0;
  const { service } = createService({
    agentStream: async function* () { agentCalls += 1; yield { text: "{}" }; },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" }
  });
  const result = await service.createTicket({ projectId: "P1", content: "Create ticket\ntitle: Direct parse\nobjective: Parsed without the leader.\nacceptance_criteria: works directly" });
  assert.equal(result.created, true);
  assert.equal(agentCalls, 0);
  assert.equal(result.ticket.title, "Direct parse");
});
test("hallucinated leader paths are stripped and resolved server-side", async () => {
  const seen = [];
  const { service } = createService({
    agentStream: async function* ({ payload }) {
      seen.push(payload.text);
      yield { text: '```json\n{"title":"Fix chat","objective":"Fix the chat panel.","acceptance_criteria":["Panel works."],"style":["frontend"],"candidate_files":[{"path":"web/src/components/chat/ChatPanel.tsx","role":"PATCH","reason":"made up"}]}\n```' };
    },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" },
    candidateResolver: { resolve: async (draft) => ({ ...draft, candidate_files: [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "REFERENCE", reason: "retrieval:real-file" }], candidates_produced_by: "retrieval", candidates_produced_at: "2026-09-23T00:00:00Z" }) }
  });
  const result = await service.createTicket({ projectId: "P1", content: "fix chat panel" });
  assert.equal(result.created, true);
  assert.match(seen[0], /never invent file paths/);
  assert.deepEqual(result.ticket.candidate_files, [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "REFERENCE", reason: "retrieval:real-file" }]);
  assert.equal(result.ticket.candidates_produced_by, "retrieval");
});

test("leader text without resolver falls back to marked placeholder candidates", async () => {
  const { service } = createService({
    agentStream: async function* () {
      yield { text: '```json\n{"title":"Fix API","objective":"Fix the endpoint.","acceptance_criteria":["Endpoint works."],"style":["backend"]}\n```' };
    },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" }
  });
  const result = await service.createTicket({ projectId: "P1", content: "fix api" });
  assert.equal(result.created, true);
  assert.equal(result.ticket.candidate_files.length, 1);
  assert.match(result.ticket.candidate_files[0].reason, /^legacy-backfill:/);
});
