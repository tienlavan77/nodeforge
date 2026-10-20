// Verifies project SSE snapshots, live activity, routing, and reconnect cursors remain isolated.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createProjectStream } from "../../src/transport/sse/project-stream.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createProjectStreamClient } from "../../../ui/nextjs/lib/project-stream-client.js";

// Captures executable SSE frames and connection teardown without a network dependency.
function responseFixture() {
  return {
    events: [], headers: {}, writableEnded: false,
    // Records HTTP status for stream selection and removed-project assertions.
    writeHead(status) { this.status = status; },
    // Supports the HTTP server's CORS headers.
    setHeader(name, value) { this.headers[name] = value; },
    // Decodes actual emitted SSE envelopes rather than inspecting source code.
    write(chunk) {
      const data = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (data) this.events.push(JSON.parse(data.slice(6)));
    },
    // Tracks whether closing one subscription interrupts another project.
    end() { this.writableEnded = true; }
  };
}

// Builds streams sharing live and snapshot sources to exercise every project attribution boundary.
function streamFixture() {
  const eventBus = new EventEmitter();
  const subscriptions = createSubscriptionRegistry();
  const streams = new Map();
  const activity = [activityEvent("A"), activityEvent("B"), activityEvent(undefined)];
  for (const projectId of ["A", "B"]) {
    streams.set(projectId, createProjectStream({ projectId, eventBus, subscriptions,
      watcherSnapshot: { snapshot: () => Object.freeze({ watcher: Object.freeze({ recent_events: [
        { project_id: "A", payload: { path: "A.js" } },
        { project_id: "B", payload: { path: "B.js" } },
        { project_id: "A", metadata: { project_id: "B" }, payload: { path: "conflict.js" } }
      ] }) }) }, agentActivitySnapshot: () => activity
    }));
  }
  return { eventBus, subscriptions, streams };
}

// Supplies valid business activity while varying project attribution independently.
function activityEvent(projectId) {
  return { event_type: "agent.activity", project_id: projectId, payload: {
    agent_id: "CODER-1", activity_type: "started", status: "working", summary: `Work for ${projectId}`
  } };
}

test("simultaneous streams reject foreign, contradictory, and unattributed live and snapshot activity", (context) => {
  const fixture = streamFixture();
  const responses = new Map();
  for (const projectId of ["A", "B"]) {
    const response = responseFixture();
    responses.set(projectId, response);
    const connection = fixture.streams.get(projectId).connect({ requestedProjectId: projectId, response });
    context.after(() => connection.close());
    assert.deepEqual(response.events[1].payload.watcher.recent_events.map((event) => event.payload.path), [`${projectId}.js`]);
    assert.deepEqual(response.events.filter((event) => event.event_type === "agent.activity").map((event) => event.payload.summary), [`Work for ${projectId}`]);
  }
  for (const event of [activityEvent("A"), activityEvent("B"), activityEvent(undefined),
    { ...activityEvent("A"), metadata: { project_id: "B" } },
    { ...activityEvent(undefined), metadata: { project_id: "A" } }]) {
    fixture.eventBus.emit("agent.activity", event);
    fixture.subscriptions.publish(event);
  }
  for (const projectId of ["A", "B"]) {
    const events = responses.get(projectId).events;
    assert(events.every((event) => event.project_id === projectId));
    const activities = events.filter((event) => event.event_type === "agent.activity");
    assert.equal(activities.length, projectId === "A" ? 5 : 3);
    assert(activities.every((event) => event.payload.summary !== `Work for ${projectId === "A" ? "B" : "A"}`));
  }
  const before = responses.get("B").events.length;
  fixture.eventBus.emit("watcher.indexed", { payload: { path: "unattributed.js" } });
  fixture.eventBus.emit("watcher.indexed", { metadata: { project_id: "A" }, payload: { path: "only-A.js" } });
  assert.equal(responses.get("B").events.length, before);
  assert.equal(responses.get("A").events.at(-1).payload.path, "only-A.js");
});

test("HTTP stream selection, reconnect snapshots, and project removal leave the other stream live", async (context) => {
  const fixture = streamFixture();
  const routers = new Map([...fixture.streams].map(([projectId, projectStream]) => [projectId,
    createForgeV1Router({ expectedProjectId: projectId, projectStream })]));
  const api = createHttpApi({ forgeV1Router: createForgeV1Router({ resolveProjectRouter: (projectId) => routers.get(projectId) }) });
  // Exercises the real public HTTP handler and records close events for each socket.
  async function connect(projectId, cursor) {
    const request = Object.assign(new EventEmitter(), { method: "GET", url: `/forge/v1/stream?project=${projectId}`, headers: cursor ? { "last-event-id": cursor } : {} });
    const response = responseFixture();
    await api.handler(request, response);
    context.after(() => request.emit("close"));
    return { request, response };
  }
  const first = await connect("A");
  const second = await connect("B");
  first.request.emit("close");
  const reconnected = await connect("A", first.response.events.at(-1).event_id);
  assert.equal(reconnected.response.events[0].payload.replay_from, first.response.events.at(-1).event_id);
  assert.deepEqual(reconnected.response.events[1].payload.watcher.recent_events.map((event) => event.payload.path), ["A.js"]);
  routers.delete("A");
  reconnected.request.emit("close");
  const removed = await connect("A");
  assert.equal(removed.response.status, 404);
  const before = second.response.events.length;
  fixture.eventBus.emit("agent.activity", activityEvent("B"));
  assert.equal(second.response.events.length, before + 1);
  assert.equal(second.response.writableEnded, false);
  assert(second.response.events.every((event) => event.project_id === "B"));
  assert.equal(fixture.eventBus.listenerCount("agent.activity"), 1);
});

test("client keeps simultaneous project subscriptions and reconnect cursors isolated", async (context) => {
  const original = globalThis.EventSource;
  const sources = [];
  globalThis.EventSource = class {
    // Records the selected project and replay cursor for actual reconnect attempts.
    constructor(url) { this.url = url; this.handlers = new Map(); this.readyState = 1; sources.push(this); }
    // Registers the real reconnect wrapper used by the project client.
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    // Simulates terminal socket closure while preserving handler references for stale-event tests.
    close() { this.readyState = 2; }
  };
  const receivedA = [];
  const receivedB = [];
  const errors = [];
  const client = createProjectStreamClient((path, query) => `${path}?${new URLSearchParams(query)}`);
  const first = client({ projectId: "A", onEvent: (event) => receivedA.push(event), onError: (error) => errors.push(error.code) });
  const second = client({ projectId: "B", onEvent: (event) => receivedB.push(event) });
  context.after(() => { first.close(); second.close(); globalThis.EventSource = original; });
  // Delivers a valid stream envelope through native EventSource listeners.
  function emit(source, projectId, eventId) {
    const event = { event_id: eventId, event_type: "stream.connected", schema_version: 1, project_id: projectId,
      timestamp: new Date().toISOString(), payload: { stream_id: "STREAM-1", replay_from: null } };
    source.handlers.get(event.event_type)({ data: JSON.stringify(event), lastEventId: eventId });
  }
  emit(sources[0], "A", "A-1");
  emit(sources[1], "B", "B-1");
  emit(sources[0], "B", "FOREIGN-1");
  assert.equal(first.getLastEventId(), "A-1");
  assert.deepEqual(receivedA.map((event) => event.event_id), ["A-1"]);
  sources[0].readyState = 2;
  sources[0].onerror(new Error("restart"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
  assert.equal(sources.length, 3);
  assert.equal(new URL(sources[2].url, "http://localhost").searchParams.get("project"), "A");
  assert.equal(new URL(sources[2].url, "http://localhost").searchParams.get("after"), "A-1");
  emit(sources[0], "A", "STALE");
  emit(sources[2], "A", "A-2");
  first.close();
  emit(sources[1], "B", "B-2");
  assert.equal(sources[1].readyState, 1);
  assert.deepEqual(receivedA.map((event) => event.event_id), ["A-1", "A-2"]);
  assert.deepEqual(receivedB.map((event) => event.event_id), ["B-1", "B-2"]);
  assert(errors.includes("STREAM_INVALID_EVENT"));
});
