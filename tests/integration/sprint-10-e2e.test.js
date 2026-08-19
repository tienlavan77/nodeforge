import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";
import { createRuntimeService } from "../../src/application/runtime-service.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createExternalAgentOrchestrator } from "../../src/modules/agent/external-agent-orchestrator.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createMemoryRetriever } from "../../src/modules/history/memory-retriever.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";
import { createRuntimeRecovery } from "../../src/modules/recovery/runtime-recovery.js";
import { runCli } from "../../src/transport/cli/index.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createRuntimeSse } from "../../src/transport/sse/runtime-stream.js";

test("verifies Sprint 10 end-to-end across CLI, HTTP, Runtime, Agents, Memory, and SSE", async () => {
  const projectId = "PROJECT-112";
  const taskId = "TASK-112";
  const subscriptions = createSubscriptionRegistry();
  const eventStore = createEventStore();
  const publisher = createEventPublisher({ store: eventStore, subscriptions });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const memoryRetriever = createMemoryRetriever({ memory });
  const runtimeService = createRuntimeService({
    createSessionId: () => "SESSION-112",
    memoryRetriever
  });
  const builderCalls = [];
  const reviewerCalls = [];
  const builder = createBuilderAdapter({ id: "AGENT-builder-112", perform: async () => { builderCalls.push(taskId); return { outcome: "built" }; } });
  const reviewer = createReviewerAdapter({ id: "AGENT-reviewer-112", perform: async () => { reviewerCalls.push(taskId); return { outcome: "approved" }; } });
  const orchestrator = createExternalAgentOrchestrator({
    builder,
    reviewer,
    publisher,
    summaries,
    memory,
    createSessionId: () => "SESSION-112-runtime",
    clock: () => new Date("2026-08-20T05:00:00Z")
  });
  const sseChunks = [];
  const sse = createRuntimeSse({ subscriptions });
  const stream = sse.connect({ writeHead() {}, write: (chunk) => sseChunks.push(chunk), end() {} });
  const stdout = [];
  const cliOptions = { runtimeService, stdout: { write: (chunk) => stdout.push(chunk) }, stderr: { write() {} }, signalEmitter: new EventEmitter() };

  assert.equal(await runCli(["run", projectId, taskId], cliOptions), 0);
  assert.deepEqual(JSON.parse(stdout[0]), { id: "SESSION-112", state: "RUNNING", created_at: JSON.parse(stdout[0]).created_at, updated_at: JSON.parse(stdout[0]).updated_at });

  const http = createHttpApi({ runtimeService });
  assert.deepEqual(await request(http, "GET", "/sessions/SESSION-112"), [200, runtimeService.getSession("SESSION-112")]);
  assert.deepEqual(await request(http, "POST", "/sessions/SESSION-112/pause"), [200, { ...runtimeService.getSession("SESSION-112"), state: "PAUSED" }]);
  assert.deepEqual(await request(http, "POST", "/sessions/SESSION-112/resume"), [200, { ...runtimeService.getSession("SESSION-112"), state: "RUNNING" }]);

  const result = await orchestrator.run({ projectId, taskId, task: { id: taskId, type: "feature", title: "Migrate auth for Sprint 10 integration" }, context: { projectFacts: [] } });
  assert.deepEqual(builderCalls, [taskId]);
  assert.deepEqual(reviewerCalls, [taskId]);
  assert.equal(result.status, "completed");
  assert.deepEqual(eventStore.getAll().map(({ event_type }) => event_type), ["agent.started", "agent.plan.created", "agent.completed"]);
  assert.deepEqual(result.projectMemory.facts, ["Agent completed: Migrate auth for Sprint 10 integration."]);
  assert.equal(sseChunks.length, 2);
  assert.match(sseChunks[0], /event: agent\.started/);
  assert.match(sseChunks[1], /event: agent\.completed/);

  stream.close();
  const terminalRecovery = createRuntimeRecovery({ sessionStore: { loadAll: () => [{ id: "SESSION-112-runtime", state: "COMPLETED" }] } });
  assert.deepEqual(terminalRecovery.recover(), { recoveredSessions: [] });
  assert.deepEqual(await request(http, "GET", `/projects/${projectId}/memory?taskId=${taskId}&query=auth`), [200, { project_id: projectId, task_id: taskId, source: "project_memory", relevant_facts: ["Agent completed: Migrate auth for Sprint 10 integration."] }]);
});

async function request(api, method, url, body) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.url = url;
  const response = { status: 0, chunks: [], writeHead(status) { this.status = status; }, end(chunk) { this.chunks.push(chunk); } };
  await api.handler(request, response);
  return [response.status, JSON.parse(response.chunks.join(""))];
}
