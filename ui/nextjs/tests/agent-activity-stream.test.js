// Verifies live agent tool events reach the project monitor through the browser SSE client.
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectStreamClient } from "../lib/project-stream-client.js";

// Delivers a project-scoped agent activity frame to a subscribed workspace.
test("project stream forwards normalized agent activity to the monitor", () => {
  const previousEventSource = globalThis.EventSource;
  const sources = [];
  globalThis.EventSource = class {
    constructor() { this.handlers = new Map(); this.readyState = 0; sources.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    close() { this.readyState = 2; }
  };
  try {
    const received = [];
    const client = createProjectStreamClient(() => "/forge/v1/stream");
    const subscription = client({ projectId: "PROJECT-1", onEvent: (event) => received.push(event) });
    const activity = { event_id: "EVT-1", event_type: "agent.activity", schema_version: 1, project_id: "PROJECT-1", timestamp: "2026-10-06T00:00:00.000Z", payload: { agent_id: "engineer", activity_type: "tool_completed", status: "success", summary: "Forge tool search_text success", tool_name: "search_text" } };
    assert.ok(sources[0].handlers.has("agent.activity"));
    sources[0].handlers.get("agent.activity")({ data: JSON.stringify(activity), lastEventId: activity.event_id });
    assert.deepEqual(received, [activity]);
    subscription.close();
  } finally {
    globalThis.EventSource = previousEventSource;
  }
});
