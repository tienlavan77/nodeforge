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
