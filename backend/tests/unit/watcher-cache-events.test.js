// Verifies watcher cache changes travel through the existing project event POST route.
import assert from "node:assert/strict";
import test from "node:test";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createWatcherCacheEvents } from "../../src/modules/context/watcher-cache-events.js";

test("POST watcher changes refresh once, delete, and reject unsafe cache mutations", async () => {
  const actions = [];
  const codeCache = {
    refreshChanged: async (input) => { actions.push(["refresh", input]); return "refreshed"; },
    invalidate: (input) => { actions.push(["invalidate", input]); return true; }
  };
  const onWatcherEvent = createWatcherCacheEvents({ projectId: "P", codeCache });
  const router = createForgeV1Router({ projectStream: { ingest: () => ({ accepted: true }) }, onWatcherEvent });
  const url = new URL("http://localhost/forge/v1/stream/events");
  // Sends a real JSON body through the router instead of calling the cache handler directly.
  async function post(event) {
    const request = { headers: {}, async *[Symbol.asyncIterator]() { yield JSON.stringify(event); } };
    return router.route("POST", url, request);
  }
  const event = { project_id: "P", event_id: "EVT-1", type: "watcher.file_modified", payload: { path: "src/a.js", sha256: `sha256:${"a".repeat(64)}` } };
  assert.equal((await post(event)).status, 202);
  await post(event);
  assert.deepEqual(actions, [["refresh", { path: "src/a.js", expectedSha256: event.payload.sha256 }]]);
  await post({ ...event, event_id: "EVT-2", type: "watcher.file_deleted" });
  await post({ ...event, event_id: "EVT-3", payload: { path: "../.env" } });
  await post({ ...event, event_id: "EVT-4", project_id: "OTHER" });
  assert.deepEqual(actions[1], ["invalidate", { path: "src/a.js" }]);
  assert.equal(actions.length, 2);
});

test("rename invalidates the old cached path and refreshes only an already cached destination", async () => {
  const actions = [];
  const codeCache = {
    refreshChanged: async (input) => { actions.push(["refresh", input]); return "refreshed"; },
    invalidate: (input) => { actions.push(["invalidate", input]); return true; }
  };
  const onWatcherEvent = createWatcherCacheEvents({ projectId: "P", codeCache });
  assert.equal(await onWatcherEvent({ project_id: "P", event_id: "RENAME-1", type: "watcher.file_renamed", payload: { path: "src/new.js", old_path: "src/old.js" } }), "refreshed");
  assert.deepEqual(actions, [["invalidate", { path: "src/old.js" }], ["refresh", { path: "src/new.js", expectedSha256: undefined }]]);
});
