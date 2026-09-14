import assert from "node:assert/strict";
import test from "node:test";

import { createNodeClient } from "../../../ui/nextjs/lib/node-client.js";

test("Node client opens the project SSE stream and validates project events", () => {
  const previous = globalThis.EventSource;
  const sources = [];
  globalThis.EventSource = class MockEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; sources.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
    emit(type, data, lastEventId) { this.listeners.get(type)?.({ type, data: JSON.stringify(data), lastEventId }); }
  };
  try {
    const events = [];
    const errors = [];
    const stream = createNodeClient().connectProjectStream({ projectId: "PROJECT-STREAM-CLIENT", afterEventId: "EVT-0", onEvent: (event) => events.push(event), onError: (error) => errors.push(error) });
    const source = sources[0];
    assert.match(source.url, /\/forge\/v1\/stream\?project=PROJECT-STREAM-CLIENT&after=EVT-0/);
    source.emit("stream.connected", { event_id: "EVT-1", event_type: "stream.connected", schema_version: 1, project_id: "PROJECT-STREAM-CLIENT", timestamp: "2026-09-11T00:00:00.000Z", payload: { stream_id: "STREAM-1", replay_from: "EVT-0" } }, "EVT-1");
    source.emit("stream.connected", { event_id: "EVT-1", event_type: "stream.connected", schema_version: 1, project_id: "PROJECT-STREAM-CLIENT", timestamp: "2026-09-11T00:00:00.000Z", payload: { stream_id: "STREAM-1", replay_from: "EVT-0" } }, "EVT-1");
    source.emit("watcher.file_indexed", { event_id: "EVT-2", event_type: "watcher.file_indexed", schema_version: 1, project_id: "OTHER", timestamp: "2026-09-11T00:00:00.000Z", payload: { path: "ignored.js", indexed_at: "2026-09-11T00:00:00.000Z" } });
    assert.equal(events.length, 1);
    assert.equal(stream.getLastEventId(), "EVT-1");
    assert.equal(errors.length, 1);
    stream.close();
    assert.equal(source.closed, true);
  } finally {
    globalThis.EventSource = previous;
  }
});
