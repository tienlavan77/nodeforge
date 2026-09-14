import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createHttpApi } from "../../src/transport/http/server.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

test("routes REST requests exclusively through Runtime Service", async () => {
  const calls = [];
  const runtime = {
    startTask(input) { calls.push(["startTask", input]); return { id: "SESSION-105", state: "RUNNING" }; },
    pauseSession(id) { calls.push(["pauseSession", id]); return { id, state: "PAUSED" }; },
    resumeSession(id) { calls.push(["resumeSession", id]); return { id, state: "RUNNING" }; },
    getSession(id) { calls.push(["getSession", id]); return { id, state: "RUNNING" }; },
    getProjectMemory(input) { calls.push(["getProjectMemory", input]); return { relevant_facts: ["Auth migrated to v2."] }; }
  };
  const api = createHttpApi({ runtimeService: runtime });
  assert.deepEqual(await request(api, "POST", "/tasks", { projectId: "PROJECT-105", taskId: "TASK-105" }), [201, { id: "SESSION-105", state: "RUNNING" }]);
  assert.deepEqual(await request(api, "POST", "/sessions/SESSION-105/pause"), [200, { id: "SESSION-105", state: "PAUSED" }]);
  assert.deepEqual(await request(api, "POST", "/sessions/SESSION-105/resume"), [200, { id: "SESSION-105", state: "RUNNING" }]);
  assert.deepEqual(await request(api, "GET", "/sessions/SESSION-105"), [200, { id: "SESSION-105", state: "RUNNING" }]);
  assert.deepEqual(await request(api, "GET", "/projects/PROJECT-105/memory?taskId=TASK-105&query=auth&domain=security"), [200, { relevant_facts: ["Auth migrated to v2."] }]);
  assert.deepEqual(calls, [
    ["startTask", { projectId: "PROJECT-105", taskId: "TASK-105" }], ["pauseSession", "SESSION-105"], ["resumeSession", "SESSION-105"],
    ["getSession", "SESSION-105"], ["getProjectMemory", { projectId: "PROJECT-105", taskId: "TASK-105", query: "auth", domain: "security" }]
  ]);
});

test("routes the Architecture Workspace through its Node application service", async () => {
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    architectureWorkspaceService: { getWorkspace: (projectId) => ({ project_id: projectId, agent: { status: "READY" } }) }
  });
  assert.deepEqual(await request(api, "GET", "/projects/PROJECT-138/architecture-workspace"), [200, { project_id: "PROJECT-138", agent: { status: "READY" } }]);
});

test("serves the parallel Forge v1 ticket run route", async () => {
  let received;
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    forgeV1Router: createForgeV1Router({
      dispatchTicket: async (input) => { received = input; return { ticket_id: input.ticketId, supervisor_id: "SUP-V1", status: "accepted", pipeline: "supervisor" }; }
    })
  });
  const [status, result] = await request(api, "POST", "/forge/v1/tickets/FORGE-1:run?project=PROJECT-1");
  assert.equal(status, 202);
  assert.equal(result.ticket_id, "FORGE-1");
  assert.equal(result.supervisor_id, "SUP-V1");
  assert.equal(result.status, "accepted");
  assert.equal(result.pipeline, "supervisor");
  assert.match(result.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.correlation_id, result.request_id);
  assert.deepEqual(received, { projectId: "PROJECT-1", ticketId: "FORGE-1", conversationId: "CONV-BUILDER" });
});

test("serves the Forge v1 ticket CRUD collection and item routes", async () => {
  const calls = [];
  const ticket = { id: "TICKET-1", project_id: "PROJECT-1", title: "T", objective: "O", acceptance_criteria: ["A"] };
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    forgeV1Router: createForgeV1Router({
      ticketCrudService: {
        listTickets: (input) => { calls.push(["list", input]); return [ticket]; },
        createTicket: (input) => { calls.push(["create", input]); return { created: true, ticket: input.ticket }; },
        updateTicket: (input) => { calls.push(["update", input]); return { updated: true, ticket: { ...ticket, title: "T2" } }; }
      },
      projectDashboardService: { getTicket: (projectId, ticketId) => { calls.push(["detail", { projectId, ticketId }]); return { id: ticketId, project_id: projectId }; } },
      sprintPlanUploadService: { removeTicket: (input) => { calls.push(["delete", input]); return { deleted: true, ticket_id: input.ticketId }; } }
    })
  });
  assert.deepEqual(await request(api, "GET", "/forge/v1/tickets?project=PROJECT-1"), [200, [ticket]]);
  const [createStatus, created] = await request(api, "POST", "/forge/v1/tickets?project=PROJECT-1", { ticket });
  assert.equal(createStatus, 201);
  assert.deepEqual(created, { created: true, ticket });
  const [createStatusBody, createdBody] = await request(api, "POST", "/forge/v1/tickets", { project_id: "PROJECT-1", ticket });
  assert.equal(createStatusBody, 201);
  assert.deepEqual(createdBody, { created: true, ticket });
  assert.deepEqual(await request(api, "GET", "/forge/v1/tickets/TICKET-1?project=PROJECT-1"), [200, { id: "TICKET-1", project_id: "PROJECT-1" }]);
  const [updateStatus, updated] = await request(api, "PUT", "/forge/v1/tickets/TICKET-1?project=PROJECT-1", { title: "T2" });
  assert.equal(updateStatus, 200);
  assert.deepEqual(updated, { updated: true, ticket: { ...ticket, title: "T2" } });
  assert.deepEqual(await request(api, "DELETE", "/forge/v1/tickets/TICKET-1?project=PROJECT-1"), [200, { deleted: true, ticket_id: "TICKET-1" }]);
  assert.deepEqual(calls, [
    ["list", { projectId: "PROJECT-1" }],
    ["create", { projectId: "PROJECT-1", ticket, content: undefined, sprintId: undefined }],
    ["create", { projectId: "PROJECT-1", ticket, content: undefined, sprintId: undefined }],
    ["detail", { projectId: "PROJECT-1", ticketId: "TICKET-1" }],
    ["update", { projectId: "PROJECT-1", ticketId: "TICKET-1", patch: { title: "T2" } }],
    ["delete", { projectId: "PROJECT-1", ticketId: "TICKET-1" }]
  ]);
});

test("rejects Forge v1 ticket CRUD without a project context", async () => {
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    forgeV1Router: createForgeV1Router({ ticketCrudService: { listTickets: () => [], createTicket: () => ({}), updateTicket: () => ({}) } })
  });
  assert.equal((await request(api, "GET", "/forge/v1/tickets"))[0], 400);
  assert.equal((await request(api, "POST", "/forge/v1/tickets", { ticket: {} }))[0], 400);
  assert.equal((await request(api, "PUT", "/forge/v1/tickets/TICKET-1", { title: "T" }))[0], 400);
  assert.equal((await request(api, "DELETE", "/forge/v1/tickets/TICKET-1"))[0], 400);
});

test("routes the Project Dashboard through its Node application service", async () => {
  const api = createHttpApi({ runtimeService: runtimeStub(), projectDashboardService: { getDashboard: (projectId) => ({ project_id: projectId, backlog: [] }) } });
  assert.deepEqual(await request(api, "GET", "/projects/PROJECT-140/dashboard"), [200, { project_id: "PROJECT-140", backlog: [] }]);
});

test("routes ticket Run through the canonical Stage-1 runner", async () => {
  let received;
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    ticketRunner: async (input) => {
      received = input;
      return { ticket_id: input.ticketId, status: "accepted", pipeline: "stage1" };
    }
  });
  assert.deepEqual(
    await request(api, "POST", "/projects/PROJECT-NODEFORGE/tickets/FORGE-1/run"),
    [202, { ticket_id: "FORGE-1", status: "accepted", pipeline: "stage1" }]
  );
  assert.deepEqual(received, {
    projectId: "PROJECT-NODEFORGE",
    ticketId: "FORGE-1",
    conversationId: "CONV-BUILDER"
  });
});

test("routes Sprint Run through the Supervisor dispatch hook", async () => {
  let received;
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    dispatchSprint: async (input) => { received = input; return { sprint_id: input.sprintId, status: "accepted", pipeline: "supervisor" }; }
  });
  assert.deepEqual(await request(api, "POST", "/sprints/SPRINT-1/run?project=PROJECT-142"), [202, { sprint_id: "SPRINT-1", status: "accepted", pipeline: "supervisor" }]);
  assert.deepEqual(received, { projectId: "PROJECT-142", sprintId: "SPRINT-1" });
});

test("routes read-only Conversation and Audit History filters through Node", async () => {
  let received;
  const api = createHttpApi({ runtimeService: runtimeStub(), conversationAuditHistoryService: { query: (input) => { received = input; return { items: [], next_cursor: null }; } } });
  assert.deepEqual(await request(api, "GET", "/projects/PROJECT-141/history?agent=architecture-manager&conversationId=CONV-141&correlationId=CORR-141&type=owner.message&cursor=5&limit=10"), [200, { items: [], next_cursor: null }]);
  assert.deepEqual(received, { projectId: "PROJECT-141", agentId: "architecture-manager", conversationId: "CONV-141", correlationId: "CORR-141", type: "owner.message", cursor: "5", limit: 10 });
});

test("routes Human Decisions through the Node intake service", async () => {
  let received;
  const api = createHttpApi({ runtimeService: runtimeStub(), humanDecisionService: { submit: (input) => { received = input; return { decision: input }; } } });
  const body = { decision_id: "HUMAN-139B", actor: "OWNER", proposal_id: "PROPOSAL", decision: "APPROVE", correlation_id: "CORR", timestamp: "2026-08-21T15:00:00Z" };
  const [status, result] = await request(api, "POST", "/projects/PROJECT-139B/decisions", body);
  assert.equal(status, 201);
  assert.equal(result.decision.project_id, "PROJECT-139B");
  assert.equal(received.project_id, "PROJECT-139B");
});

test("routes Agent Settings exclusively through the Node application service", async () => {
  const calls = [];
  const service = {
    list: () => [{ agent_id: "builder", api_key_masked: "********" }],
    save: (input) => { calls.push(["save", input]); return { ...input, api_key_masked: "********" }; },
    testConnection: async (agentId) => { calls.push(["test", agentId]); return { agent_id: agentId, status: "CONNECTED" }; }
  };
  const api = createHttpApi({ runtimeService: runtimeStub(), agentSettingsService: service });
  assert.deepEqual(await request(api, "GET", "/agents/settings"), [200, [{ agent_id: "builder", api_key_masked: "********" }]]);
  const [saveStatus, saved] = await request(api, "PUT", "/agents/builder/settings", { gateway_url: "https://gateway.example.test/builder", enabled: true });
  assert.equal(saveStatus, 200);
  assert.equal(saved.agent_id, "builder");
  assert.deepEqual(await request(api, "POST", "/agents/builder/settings/test"), [200, { agent_id: "builder", status: "CONNECTED" }]);
  assert.deepEqual(calls, [["save", { agent_id: "builder", gateway_url: "https://gateway.example.test/builder", enabled: true }], ["test", "builder"]]);
});

function runtimeStub() {
  return { startTask: () => ({}), pauseSession: () => ({}), resumeSession: () => ({}), getSession: () => ({}), getProjectMemory: () => ({}) };
}

async function request(api, method, url, body) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.url = url;
  const response = { status: 0, headers: {}, chunks: [], setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; }, end(chunk) { this.chunks.push(chunk); } };
  await api.handler(request, response);
  return [response.status, JSON.parse(response.chunks.join(""))];
}
