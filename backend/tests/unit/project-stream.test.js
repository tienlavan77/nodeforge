import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const streamSchema = require("../../../schemas/stream/project-stream-event.schema.json");

import { createProjectStream } from "../../src/transport/sse/project-stream.js";
import { createWatcherSnapshotService } from "../../src/modules/watcher/watcher-snapshot-service.js";
import { createProjectStreamPublisher } from "../../src/transport/sse/project-stream-publisher.js";
import { createHttpApi } from "../../src/transport/http/server.js";

function runtimeStub() {
  return { startTask: () => ({}), pauseSession: () => ({}), resumeSession: () => ({}), getSession: () => ({}), getProjectMemory: () => ({}) };
}

function responseStub() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; },
    write(chunk) { this.chunks.push(chunk); },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); this.writableEnded = true; }
  };
}

test("project stream sends connected and watcher snapshot events", () => {
  const subscriptions = { subscribe: () => ({ id: "SUB-1" }), unsubscribe: () => {} };
  const response = responseStub();
  const watcherSnapshot = createWatcherSnapshotService({ indexDb: {
    all: () => [{ path: "src/new.js", language: "javascript", size_bytes: 10, sha256: null, indexed_at: "2026-09-11T00:00:00.000Z" }]
  } });
  const stream = createProjectStream({
    projectId: "PROJECT-STREAM-1",
    watcherSnapshot,
    subscriptions,
    heartbeatMs: 1000,
    clock: () => "2026-09-11T00:00:01.000Z"
  });

  const connection = stream.connect({ requestedProjectId: "PROJECT-STREAM-1", response });
  const events = response.chunks.filter((chunk) => chunk.startsWith("id: ")).map((chunk) => JSON.parse(chunk.split("data: ")[1]));
  assert.equal(response.status, 200);
  assert.deepEqual(events.map((event) => event.event_type), ["stream.connected", "stream.snapshot"]);
  assert.equal(events[1].payload.watcher.recent_events[0].payload.path, "src/new.js");
  assert.equal(connection.close(), true);
  assert.equal(response.writableEnded, true);
});

test("watcher snapshot caps results at four and normalizes nullable metadata", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ path: `src/${index}.js`, language: null, size_bytes: null, sha256: null, indexed_at: `2026-09-11T00:00:0${index}.000Z` }));
  const service = createWatcherSnapshotService({ indexDb: { all: () => rows } });
  const snapshot = service.snapshot();
  assert.equal(snapshot.watcher.recent_events.length, 4);
  assert.equal(snapshot.watcher.recent_events[0].payload.language, null);
});

test("project stream publisher normalizes watcher events and rejects other projects", () => {
  const publisher = createProjectStreamPublisher({ projectId: "PROJECT-STREAM-3", indexDb: { all: () => [{ path: "src/live.js", language: "javascript", size_bytes: 12, sha256: "abc", indexed_at: "2026-09-11T00:00:00.000Z" }] } });
  assert.equal(publisher.project({ project_id: "OTHER", type: "watcher.file_modified", payload: { path: "src/live.js" } }), null);
  const projected = publisher.project({ project_id: "PROJECT-STREAM-3", type: "watcher.file_modified", payload: { path: "src/live.js" } });
  assert.equal(projected.event_type, "watcher.file_indexed");
  assert.deepEqual(projected.payload, {
    path: "src/live.js", language: "javascript", size_bytes: 12, sha256: "abc", indexed_at: "2026-09-11T00:00:00.000Z",
    operation: "watcher.file_modified",
    activity: ["Filesystem change: src/live.js", "Watcher event: watcher.file_modified src/live.js", "Indexer updated: src/live.js"]
  });
  assert.equal(publisher.project({ project_id: "PROJECT-STREAM-3", type: "watcher.file_deleted", payload: { path: "src/live.js" }, timestamp: "2026-09-11T00:01:00.000Z" }).event_type, "watcher.file_removed");
});

test("project stream publishes indexed files and filters project scope", () => {
  const bus = new EventEmitter();
  let handler;
  const subscriptions = {
    subscribe: (_pattern, callback) => { handler = callback; return { id: "SUB-1" }; },
    unsubscribe: () => {}
  };
  const response = responseStub();
  const stream = createProjectStream({ projectId: "PROJECT-STREAM-2", indexDb: { all: () => [] }, subscriptions, eventBus: bus, heartbeatMs: 1000 });
  const connection = stream.connect({ requestedProjectId: "PROJECT-STREAM-2", response });
  handler({ event_type: "watcher.file_indexed", project_id: "OTHER", indexed: true, payload: { path: "ignored.js" }, timestamp: "2026-09-11T00:00:00.000Z" });
  bus.emit("watcher.indexed", { project_id: "PROJECT-STREAM-2", type: "watcher.file_modified", indexed: true, payload: { path: "src/live.js", language: "javascript" }, timestamp: "2026-09-11T00:00:02.000Z" });
  const events = response.chunks.filter((chunk) => chunk.startsWith("id: ")).map((chunk) => JSON.parse(chunk.split("data: ")[1]));
  assert.deepEqual(events.map((event) => event.event_type), ["stream.connected", "stream.snapshot", "watcher.file_indexed"]);
  assert.equal(events.at(-1).payload.path, "src/live.js");
  connection.close();
});

test("forge v1 project stream route requires project query", async () => {
  const api = createHttpApi({ runtimeService: runtimeStub(), projectStream: { connect: () => { throw new Error("should not connect"); } } });
  const request = Object.assign({ method: "GET", url: "/forge/v1/stream" }, { once() {} });
  const response = responseStub();
  await api.handler(request, response);
  assert.equal(response.status, 400);
  assert.match(response.chunks.join(""), /Project query parameter is required/);
});

test("project stream ingest accepts internal watcher POST events", () => {
  const received = [];
  const subscriptions = {
    subscribe: (_pattern, callback) => { received.push(callback); return { id: "SUB-POST" }; },
    unsubscribe: () => {},
    publish: (event) => { for (const callback of received) callback(event); return received.length; }
  };
  const response = responseStub();
  const stream = createProjectStream({ projectId: "PROJECT-STREAM-POST", indexDb: { all: () => [{ path: "src/live.js", language: "javascript", size_bytes: 2, sha256: "sha", indexed_at: "2026-09-12T00:00:00.000Z" }] }, subscriptions, heartbeatMs: 1000 });
  const connection = stream.connect({ requestedProjectId: "PROJECT-STREAM-POST", response });
  const result = stream.ingest({ event_id: "WATCHER-1", type: "watcher.file_modified", project_id: "PROJECT-STREAM-POST", indexed: true, timestamp: "2026-09-12T00:00:01.000Z", payload: { path: "src/live.js" } });
  assert.equal(result.accepted, true);
  const events = response.chunks.filter((chunk) => chunk.startsWith("id: ")).map((chunk) => JSON.parse(chunk.split("data: ")[1]));
  assert.equal(events.at(-1).event_type, "watcher.file_indexed");
  assert.deepEqual(events.at(-1).payload.activity, ["Filesystem change: src/live.js", "Watcher event: watcher.file_modified src/live.js", "Indexer updated: src/live.js"]);
  connection.close();
});

test("project stream projects ticket and sprint events", () => {
  const subscriptions = { subscribe: (_pattern, callback) => { subscriptions.callback = callback; return { id: "SUB-PROJECT" }; }, unsubscribe: () => {}, publish: (event) => { subscriptions.callback?.(event); return 1; } };
  const response = responseStub();
  const stream = createProjectStream({ projectId: "PROJECT-STREAM-DOMAIN", indexDb: { all: () => [] }, subscriptions, heartbeatMs: 1000 });
  const connection = stream.connect({ requestedProjectId: "PROJECT-STREAM-DOMAIN", response });
  stream.ingest({ type: "ticket.status_change", project_id: "PROJECT-STREAM-DOMAIN", payload: { ticket_id: "TICKET-1", from: "running", to: "done" } });
  stream.ingest({ type: "sprint.updated", project_id: "PROJECT-STREAM-DOMAIN", payload: { sprint_id: "SPRINT-1" } });
  const events = response.chunks.filter((chunk) => chunk.startsWith("id: ")).map((chunk) => JSON.parse(chunk.split("data: ")[1]));
  assert.deepEqual(events.slice(-2).map((event) => event.event_type), ["ticket.status_changed", "sprint.updated"]);
  assert.equal(events.at(-2).payload.ticket_id, "TICKET-1");
  assert.equal(events.at(-1).payload.sprint_id, "SPRINT-1");
  connection.close();
});

test("project stream normalizes ticket status payloads to the agreed contract", () => {
  const publisher = createProjectStreamPublisher({ projectId: "PROJECT-STREAM-NORM", indexDb: { all: () => [] } });
  const projected = publisher.project({ type: "ticket.status_change", project_id: "PROJECT-STREAM-NORM", timestamp: "2026-09-14T10:00:00.000Z", payload: { ticket_id: "FORGE-UI-052", from: "running", to: "done", version: 7, reason: "verify", details: { error: null } } });
  assert.deepEqual(projected, {
    event_type: "ticket.status_changed",
    payload: { ticket_id: "FORGE-UI-052", previous_status: "running", status: "done", updated_at: "2026-09-14T10:00:00.000Z" }
  });
  const explicit = publisher.project({ type: "ticket.status_changed", project_id: "PROJECT-STREAM-NORM", timestamp: "2026-09-14T11:00:00.000Z", payload: { ticket_id: "FORGE-UI-052", previous_status: "pending", status: "running", updated_at: "2026-09-14T11:00:01.000Z" } });
  assert.deepEqual(explicit.payload, { ticket_id: "FORGE-UI-052", previous_status: "pending", status: "running", updated_at: "2026-09-14T11:00:01.000Z" });
});

test("project stream keeps ticket and sprint snapshots but drops internal fields", () => {
  const publisher = createProjectStreamPublisher({ projectId: "PROJECT-STREAM-NORM", indexDb: { all: () => [] } });
  const created = publisher.project({ type: "ticket.created", project_id: "PROJECT-STREAM-NORM", timestamp: "2026-09-14T10:00:00.000Z", payload: { ticket_id: "TICKET-C", ticket: { id: "TICKET-C", title: "C" }, roadmap_version: "1.0.0", sprint_id: "SPRINT-C", patch: { hidden: true } } });
  assert.deepEqual(created.payload, { ticket_id: "TICKET-C", ticket: { id: "TICKET-C", title: "C" }, roadmap_version: "1.0.0", sprint_id: "SPRINT-C", updated_at: "2026-09-14T10:00:00.000Z" });
  const sprintCreated = publisher.project({ type: "sprint.created", project_id: "PROJECT-STREAM-NORM", timestamp: "2026-09-14T10:00:00.000Z", payload: { sprint_id: "SPRINT-C", sprint_plan: { id: "SPRINT-C" }, ticket_ids: ["TICKET-C"] } });
  assert.deepEqual(sprintCreated.payload, { sprint_id: "SPRINT-C", sprint_plan: { id: "SPRINT-C" }, ticket_ids: ["TICKET-C"], updated_at: "2026-09-14T10:00:00.000Z" });
  const deleted = publisher.project({ type: "ticket.deleted", project_id: "PROJECT-STREAM-NORM", timestamp: "2026-09-14T10:05:00.000Z", payload: { ticket_id: "TICKET-C", sprint_id: "SPRINT-C" } });
  assert.deepEqual(deleted.payload, { ticket_id: "TICKET-C", sprint_id: "SPRINT-C", updated_at: "2026-09-14T10:05:00.000Z" });
});

test("project stream framing validates every emitted event against the v1 schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(streamSchema);
  const response = responseStub();
  const stream = createProjectStream({
    projectId: "PROJECT-STREAM-SCHEMA",
    indexDb: { all: () => [] },
    subscriptions: { subscribe: () => ({ id: "SUB-1" }), unsubscribe: () => {} },
    heartbeatMs: 1000,
    clock: () => "2026-09-11T00:00:00.000Z"
  });
  const connection = stream.connect({ requestedProjectId: "PROJECT-STREAM-SCHEMA", response });
  const frames = response.chunks.filter((chunk) => chunk.startsWith("id: "));
  assert.ok(frames.every((frame) => frame.endsWith("\n\n")));
  for (const frame of frames) {
    const event = JSON.parse(frame.split("data: ")[1]);
    assert.equal(validate(event), true, ajv.errorsText(validate.errors));
  }
  connection.close();
});

test("project stream sends heartbeat comments and stops after cleanup", async () => {
  let handler;
  const response = responseStub();
  const subscriptions = {
    subscribe: (_pattern, callback) => { handler = callback; return { id: "SUB-HEARTBEAT" }; },
    unsubscribe: () => {}
  };
  const stream = createProjectStream({ projectId: "PROJECT-STREAM-HEARTBEAT", indexDb: { all: () => [] }, subscriptions, heartbeatMs: 1000 });
  const connection = stream.connect({ requestedProjectId: "PROJECT-STREAM-HEARTBEAT", response });
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.ok(response.chunks.includes(": keep-alive\n\n"));
  connection.close();
  const count = response.chunks.length;
  handler({ event_type: "watcher.file_indexed", project_id: "PROJECT-STREAM-HEARTBEAT", payload: { path: "after-close.js" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(response.chunks.length, count);
});
