// Verifies terminal SSE failures recover automatically with preserved cursors and shared subscriptions.
import assert from "node:assert/strict";
import test from "node:test";
import { createReconnectingEventSource } from "../lib/reconnecting-event-source.js";
import { createProjectStreamClient } from "../lib/project-stream-client.js";
import { createNodeClient } from "../lib/node-client.js";

// Captures browser connections and retry timers without real sockets or delays.
function fixture(context) {
  const sources = [];
  const timers = new Map();
  let sequence = 0;
  globalThis.EventSource = class {
    // Records the URL and subscribed handlers for each replacement connection.
    constructor(url) { this.url = url; this.readyState = 0; this.handlers = new Map(); sources.push(this); }
    // Attaches a handler like the browser EventSource API.
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    // Marks an explicitly closed browser connection.
    close() { this.readyState = 2; }
  };
  // Records one pending retry instead of using wall-clock time.
  const schedule = (handler, delay) => { const id = ++sequence; timers.set(id, { handler, delay }); return id; };
  // Cancels a retry when the page or final subscriber leaves.
  const cancel = (id) => timers.delete(id);
  context.mock.method(globalThis, "setTimeout", schedule);
  context.mock.method(globalThis, "clearTimeout", cancel);
  // Executes the earliest pending retry as a deterministic backend recovery step.
  const retry = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.handler(); return timer.delay; };
  return { sources, timers, schedule, cancel, retry };
}

// Restores the original browser API after exercising an isolated fake connection.
function browserFixture(context) {
  const previous = globalThis.EventSource;
  context.after(() => { if (previous === undefined) delete globalThis.EventSource; else globalThis.EventSource = previous; });
  return fixture(context);
}

// Reopens a terminal stream with the exact replay cursor and all existing callbacks.
test("closed streams reconnect with the last event id and notify the same mounted subscriber", (context) => {
  const setup = browserFixture(context);
  const received = [];
  let opens = 0;
  const connection = createReconnectingEventSource((cursor) => `/stream?after=${cursor ?? ""}`, setup);
  connection.addEventListener("message", (event) => received.push(event.data));
  connection.onopen = () => { opens += 1; };
  setup.sources[0].handlers.get("message")({ data: "first", lastEventId: "EVT-1" });
  setup.sources[0].readyState = 2;
  setup.sources[0].onerror(new Error("HTTP 503"));
  setup.sources[0].onerror(new Error("duplicate error"));
  assert.equal(setup.timers.size, 1);
  assert.equal(setup.retry(), 1000);
  assert.equal(setup.sources[1].url, "/stream?after=EVT-1");
  setup.sources[1].readyState = 1;
  setup.sources[1].onopen();
  setup.sources[1].handlers.get("message")({ data: "recovered", lastEventId: "EVT-2" });
  setup.sources[0].handlers.get("message")({ data: "stale", lastEventId: "STALE" });
  assert.deepEqual(received, ["first", "recovered"]);
  assert.equal(opens, 1);
  connection.close();
});

// Leaves transient connection retry to the browser instead of opening a duplicate stream.
test("native CONNECTING retries do not schedule replacement sockets", (context) => {
  const setup = browserFixture(context);
  const connection = createReconnectingEventSource(() => "/stream", setup);
  setup.sources[0].onerror(new Error("Network reconnect"));
  assert.equal(setup.timers.size, 0);
  assert.equal(setup.sources.length, 1);
  connection.close();
});

// Backs off repeated downtime and resets retry delay after the API becomes available.
test("terminal retry backoff is bounded and resets on open", (context) => {
  const setup = browserFixture(context);
  const connection = createReconnectingEventSource(() => "/stream", setup);
  for (const expected of [1000, 2000, 4000, 8000, 10000, 10000]) {
    const current = setup.sources.at(-1);
    current.readyState = 2;
    current.onerror(new Error("HTTP 503"));
    assert.equal(setup.retry(), expected);
  }
  setup.sources.at(-1).onopen();
  setup.sources.at(-1).readyState = 2;
  setup.sources.at(-1).onerror(new Error("Restart"));
  assert.equal(setup.retry(), 1000);
  connection.close();
});

// Prevents unmounted pages from reopening connections even if a delayed callback fires.
test("close cancels a pending retry and ignores late browser errors", (context) => {
  const setup = browserFixture(context);
  const connection = createReconnectingEventSource(() => "/stream", setup);
  setup.sources[0].readyState = 2;
  setup.sources[0].onerror(new Error("HTTP 503"));
  const pending = [...setup.timers.values()][0].handler;
  connection.close();
  pending();
  setup.sources[0].onerror(new Error("late"));
  assert.equal(setup.timers.size, 0);
  assert.equal(setup.sources.length, 1);
});

// Keeps shared panel subscribers and duplicate-event suppression intact across reconnects.
test("project subscribers share replacement connections and keep deduplication", (context) => {
  const setup = browserFixture(context);
  const events = [[], []];
  const connect = createProjectStreamClient((path, params) => `${path}?${new URLSearchParams(params)}`);
  const first = connect({ projectId: "PROJECT-A", onEvent: (event) => events[0].push(event) });
  const second = connect({ projectId: "PROJECT-A", onEvent: (event) => events[1].push(event) });
  const event = { event_id: "EVT-1", event_type: "agent.activity", schema_version: 1, project_id: "PROJECT-A", timestamp: "2026-10-14T00:00:00Z", payload: {} };
  const frame = { data: JSON.stringify(event), lastEventId: "EVT-1" };
  setup.sources[0].handlers.get("agent.activity")(frame);
  setup.sources[0].readyState = 2;
  setup.sources[0].onerror(new Error("HTTP 503"));
  first.close();
  setup.retry();
  assert.equal(setup.sources.length, 2);
  assert.match(setup.sources[1].url, /after=EVT-1/);
  setup.sources[1].handlers.get("agent.activity")(frame);
  assert.deepEqual(events.map((received) => received.length), [1, 1]);
  assert.equal(second.getLastEventId(), "EVT-1");
  second.close();
  assert.equal(setup.sources[1].readyState, 2);
});

// Restores legacy conversation subscriptions without repeating already displayed messages.
test("conversation streams reconnect and retain message deduplication", (context) => {
  const setup = browserFixture(context);
  const messages = [];
  const subscription = createNodeClient().connectConversationStream({ projectId: "PROJECT-A", conversationId: "CONV-A", afterMessageId: "SEED", onMessage: (message) => messages.push(message) });
  assert.match(setup.sources[0].url, /after=SEED/);
  const frame = { data: JSON.stringify({ conversation_id: "CONV-A", message_id: "MESSAGE-1" }), lastEventId: "EVT-1" };
  setup.sources[0].handlers.get("conversation.message.received")(frame);
  setup.sources[0].readyState = 2;
  setup.sources[0].onerror(new Error("HTTP 503"));
  setup.retry();
  assert.match(setup.sources[1].url, /after=EVT-1/);
  setup.sources[1].handlers.get("conversation.message.received")(frame);
  assert.equal(messages.length, 1);
  subscription.close();
});
