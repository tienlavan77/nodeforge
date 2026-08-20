import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createHttpApi } from "../../src/transport/http/server.js";

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

test("routes the Project Dashboard through its Node application service", async () => {
  const api = createHttpApi({ runtimeService: runtimeStub(), projectDashboardService: { getDashboard: (projectId) => ({ project_id: projectId, backlog: [] }) } });
  assert.deepEqual(await request(api, "GET", "/projects/PROJECT-140/dashboard"), [200, { project_id: "PROJECT-140", backlog: [] }]);
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

function runtimeStub() {
  return { startTask: () => ({}), pauseSession: () => ({}), resumeSession: () => ({}), getSession: () => ({}), getProjectMemory: () => ({}) };
}

async function request(api, method, url, body) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.url = url;
  const response = { status: 0, headers: {}, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers; }, end(chunk) { this.chunks.push(chunk); } };
  await api.handler(request, response);
  return [response.status, JSON.parse(response.chunks.join(""))];
}
