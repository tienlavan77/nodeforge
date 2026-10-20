// Verifies project SSE snapshots, live activity, routing, and reconnect cursors remain isolated.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { fixture as lifecycleFixture } from "./multi-project-lifecycle-support.js";
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
  const fixture = await lifecycleFixture();
  const clients = [];
  let server;
  context.after(async () => {
    await Promise.all(clients.map((client) => client.reader.cancel()));
    await fixture.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  const lifecycle = await fixture.open();
  const entries = await Promise.all(fixture.roots.map((root) => lifecycle.add(root)));
  const [firstRuntime, secondRuntime] = await Promise.all(entries.map((entry) => lifecycle.get(entry.root)));
  // Resolves streams from active lifecycle membership, including the production runtime's connection ownership.
  async function resolveProjectRouter(projectId) {
    const entry = lifecycle.list().find((item) => item.projectId === projectId);
    const runtime = entry && await lifecycle.get(entry.root);
    return runtime && createForgeV1Router({ expectedProjectId: projectId, projectStream: runtime });
  }
  const api = createHttpApi({ forgeV1Router: createForgeV1Router({ resolveProjectRouter }) });
  server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Opens a real HTTP SSE socket and parses complete frames independently of network chunk boundaries.
  async function connect(projectId, cursor) {
    const response = await fetch(`${origin}/forge/v1/stream?project=${projectId}`, {
      headers: cursor ? { "last-event-id": cursor } : {}, signal: AbortSignal.timeout(10000)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const client = { reader, events: [], ended: false, until };
    let pending = "";
    // Uses positive delivery barriers or transport EOF, never sleeps, to bound isolation assertions.
    async function until(predicate) {
      while (!predicate(client)) {
        const chunk = await reader.read();
        if (chunk.done) {
          client.ended = true;
          assert(predicate(client), "HTTP stream ended before its delivery barrier");
          break;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const lines = frame.split("\n");
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) {
            const event = JSON.parse(data);
            assert.equal(lines.find((line) => line.startsWith("id:"))?.slice(3).trim(), event.event_id);
            client.events.push(event);
          }
        }
      }
    }
    clients.push(client);
    await until((stream) => stream.events.length >= 2);
    assert.equal(client.events[0].event_type, "stream.connected");
    assert(client.events[1].payload.watcher, "Initial watcher snapshot must arrive over HTTP");
    return client;
  }
  // Sends foreign activity before an own-project barrier on the same ordered transport.
  async function barrier(client, runtime, foreignProjectId, marker) {
    runtime.bus.emit("agent.activity", activityEvent(foreignProjectId));
    runtime.bus.emit("agent.activity", { ...activityEvent(runtime.projectId), payload: {
      ...activityEvent(runtime.projectId).payload, summary: marker
    } });
    await client.until((stream) => stream.events.some((event) => event.payload.summary === marker));
    assert(client.events.every((event) => event.project_id === runtime.projectId));
    assert(client.events.filter((event) => event.event_type === "agent.activity")
      .every((event) => event.payload.summary !== `Work for ${foreignProjectId}`));
  }
  const [first, second] = await Promise.all([connect(firstRuntime.projectId), connect(secondRuntime.projectId)]);
  await Promise.all([
    barrier(first, firstRuntime, secondRuntime.projectId, "A-before-reconnect"),
    barrier(second, secondRuntime, firstRuntime.projectId, "B-before-reconnect")
  ]);
  const cursor = first.events.at(-1).event_id;
  await first.reader.cancel();
  const reconnected = await connect(firstRuntime.projectId, cursor);
  assert.equal(reconnected.events[0].payload.replay_from, cursor);
  await Promise.all([
    barrier(reconnected, firstRuntime, secondRuntime.projectId, "A-after-reconnect"),
    barrier(second, secondRuntime, firstRuntime.projectId, "B-after-reconnect")
  ]);
  await lifecycle.remove(entries[0].root);
  await reconnected.until((stream) => stream.ended);
  assert.equal(firstRuntime.status().closed, true);
  const removed = await fetch(`${origin}/forge/v1/stream?project=${firstRuntime.projectId}`);
  assert.equal(removed.status, 404);
  await removed.arrayBuffer();
  await barrier(second, secondRuntime, firstRuntime.projectId, "B-after-A-removal");
  assert.equal(second.ended, false);
  assert.equal(secondRuntime.status().closed, false);
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
