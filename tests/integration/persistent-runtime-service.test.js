import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeService } from "../../src/application/runtime-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";
import { createPersistentEventStore } from "../../src/modules/events/persistent-event-store.js";

test("bootstraps Runtime Service from persisted sessions and replayable events after restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-runtime-service-"));
  let database = await openIndexDatabase(root);
  try {
    const first = createRuntimeService({ sessionStore: createAgentSessionStore({ database }), eventStore: createPersistentEventStore({ database }), memoryRetriever: retriever(), createSessionId: () => "SESSION-125-running" });
    first.startTask({ projectId: "PROJECT-125", taskId: "TASK-125" });
    first.pauseSession("SESSION-125-running");
    await database.close();

    database = await openIndexDatabase(root);
    const events = createPersistentEventStore({ database });
    events.append({ event_id: "EVT-125-1", event_type: "agent.started", timestamp: "2026-08-20T12:00:00Z", source: "runtime", payload: { state: "RUNNING" }, metadata: { session_id: "SESSION-125-running", task_id: "TASK-125" } });
    const restarted = createRuntimeService({ sessionStore: createAgentSessionStore({ database }), eventStore: events, memoryRetriever: retriever() });
    assert.equal(restarted.getSession("SESSION-125-running").state, "PAUSED");
    assert.deepEqual(restarted.getBootstrap().recovery.recoveredSessions.map(({ id, state }) => ({ id, state })), [{ id: "SESSION-125-running", state: "PAUSED" }]);
    assert.equal(restarted.getBootstrap().replay.state.sessions["SESSION-125-running"].state, "RUNNING");
    assert.equal(restarted.resumeSession("SESSION-125-running").state, "RUNNING");
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function retriever() {
  return { retrieve: () => ({ relevant_facts: [] }) };
}
