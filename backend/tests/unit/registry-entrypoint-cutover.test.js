// Verifies SL/ticket entrypoints cannot read or mutate stale roadmap authority in Registry deployments.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createTicketCrudService } from "../../src/application/ticket-crud-service.js";
import { createTicketHumanReviewService } from "../../src/application/ticket-human-review-service.js";
import { readRegistryTicket } from "../../src/application/registry-ticket-scope.js";
import { createBuilderContext } from "../../scripts/control-api-builder-context.mjs";
import { createHttpApi } from "../../src/transport/http/server.js";
import { once } from "node:events";

const ticket = { id: "TICKET-NEW", project_id: "PROJECT-A", sprint_id: "SPRINT-A", title: "Approved title", objective: "Approved work", dependencies: [] };
const record = { sprint_id: "SPRINT-A", project_id: "PROJECT-A", version: 1 };
const roadmaps = { getCurrent: () => { throw new Error("Legacy read forbidden"); }, updateTicketStatus: () => { throw new Error("Legacy write forbidden"); } };

// Provides immutable scope and approval checks while making any legacy access fail the test.
function registry() {
  return { getByTicket: async () => record, get: () => record, getDetail: async () => ({ project_id: "PROJECT-A", tickets: [ticket] }), listDetails: async () => [{ project_id: "PROJECT-A", tickets: [ticket] }], assertReady: async () => ({ plan: { content: { tickets: [ticket.id], ticket_specs: [ticket] } } }) };
}

test("Registry ticket list reads immutable scope and all legacy scope edits require replan", async () => {
  const service = createTicketCrudService({ roadmaps, sprintRegistry: registry(), proseTicketService: { createFromObject: () => { throw new Error("Legacy creation forbidden"); } } });
  assert.deepEqual(await service.listTickets({ projectId: "PROJECT-A" }), [ticket]);
  assert.deepEqual(await service.listTickets({ projectId: "PROJECT-B" }), []);
  await assert.rejects(service.createTicket({ projectId: "PROJECT-A", ticket }), { code: "TICKET_REPLAN_REQUIRED" });
  await assert.rejects(service.regenerateTicketEnglish({ projectId: "PROJECT-A", ticketId: ticket.id, context: "New scope" }), { code: "TICKET_REPLAN_REQUIRED" });
  assert.throws(() => service.updateTicket({ projectId: "PROJECT-A", ticketId: ticket.id, patch: { title: "Changed" } }), { code: "TICKET_REPLAN_REQUIRED" });
});

test("shared lookup rejects missing, foreign and changed binding without legacy fallback", async () => {
  const scope = registry();
  assert.deepEqual(await readRegistryTicket({ projectId: "PROJECT-A", ticketId: ticket.id, sprintRegistry: scope }), ticket);
  await assert.rejects(readRegistryTicket({ projectId: "PROJECT-B", ticketId: ticket.id, sprintRegistry: scope }), { code: "TICKET_NOT_FOUND" });
  scope.get = () => ({ ...record, version: 2 });
  await assert.rejects(readRegistryTicket({ projectId: "PROJECT-A", ticketId: ticket.id, sprintRegistry: scope }), { code: "SPRINT_PLAN_MISMATCH" });
});

test("builder context resolves current TICKET IDs and refuses unapproved scope", async () => {
  const scope = registry();
  const build = createBuilderContext({ roadmaps, sprintRegistry: scope });
  assert.match(await build({ message: { project_id: "PROJECT-A", task_id: ticket.id, payload: { text: "Run" } } }), /Approved title/);
  assert.match(await build({ message: { project_id: "PROJECT-A", payload: { text: `Implement ${ticket.id}` } } }), /Approved work/);
  scope.assertReady = async () => { throw Object.assign(new Error("Approval required"), { code: "PLAN_APPROVAL_REQUIRED" }); };
  await assert.rejects(build({ message: { project_id: "PROJECT-A", task_id: ticket.id, payload: {} } }), { code: "PLAN_APPROVAL_REQUIRED" });
});

test("Human Review reads Registry scope but cannot complete through legacy roadmap approval", async () => {
  const service = createTicketHumanReviewService({ projectId: "PROJECT-A", roadmaps, sprintRegistry: registry(), ticketStatusStore: { get: () => null, completeByHumanReview: () => { throw new Error("Unfenced completion forbidden"); } }, checkpoints: { load: async () => ({ status: "completed" }), loadReview: async () => ({ status: "completed", verdict: "request_changes" }) } });
  const evidence = await service.get({ requestedProjectId: "PROJECT-A", ticketId: ticket.id });
  assert.equal(evidence.ticket_id, ticket.id);
  assert.equal(evidence.eligible, false);
  await assert.rejects(service.approve({ requestedProjectId: "PROJECT-A", ticketId: ticket.id }), { code: "HUMAN_REVIEW_REGISTRY_REQUIRED" });
});

test("legacy HTTP Sprint/ticket aliases converge on canonical router rather than upload roadmap service", async () => {
  const calls = [];
  const server = createHttpApi({ forgeV1Router: { route: async (method, url) => { calls.push([method, url.pathname, url.searchParams.get("project")]); return { status: 200, body: { registry: true } }; } }, sprintPlanUploadService: { upload: () => { throw new Error("Legacy upload forbidden"); }, list: () => { throw new Error("Legacy route forbidden"); } } }).createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const path of ["/sprints", "/sprints/SPRINT-A", "/tickets", "/projects/PROJECT-A/tickets/TICKET-NEW"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}?project=PROJECT-A`);
      assert.deepEqual(await response.json(), { registry: true });
    }
    assert.deepEqual(calls.map((entry) => entry[1]), ["/forge/v1/sprints", "/forge/v1/sprints/SPRINT-A", "/forge/v1/tickets", "/forge/v1/projects/PROJECT-A/tickets/TICKET-NEW"]);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("production wiring sends all remaining ticket entrypoints to Registry", async () => {
  const source = await readFile("backend/scripts/start-control-api.mjs", "utf8");
  assert.match(source, /createBuilderContext\(\{ roadmaps, sprintRegistry/);
  assert.match(source, /createTicketCrudService\(\{ roadmaps, sprintRegistry/);
  assert.match(source, /createTicketHumanReviewService\(\{ projectId, roadmaps, sprintRegistry/);
  assert.match(source, /await sprintLeaderIntake.open\(\{ projectId: requestedProjectId, ticketId \}\)/);
  assert.doesNotMatch(source, /roadmaps.getCurrent\(\)\?\.sprints/);
});
