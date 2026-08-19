import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createPersistentEventStore } from "../../src/modules/events/persistent-event-store.js";

test("persists ordered events and reloads them after a database restart", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-events-"));
  let database = await openIndexDatabase(projectRoot);
  try {
    const firstStore = createPersistentEventStore({ database });
    firstStore.append(event("EVT-095-1", "agent.started"));
    firstStore.append(event("EVT-095-2", "agent.completed"));
    firstStore.append(event("EVT-095-3", "agent.completed"));
    assert.deepEqual(firstStore.getAll().map(({ event_id }) => event_id), ["EVT-095-1", "EVT-095-2", "EVT-095-3"]);
    assert.deepEqual(firstStore.getByType("agent.completed").map(({ event_id }) => event_id), ["EVT-095-2", "EVT-095-3"]);
    await database.close();

    database = await openIndexDatabase(projectRoot);
    const restartedStore = createPersistentEventStore({ database });
    assert.deepEqual(restartedStore.load().map(({ event_id }) => event_id), ["EVT-095-1", "EVT-095-2", "EVT-095-3"]);
    assert.deepEqual(restartedStore.getById("EVT-095-2"), event("EVT-095-2", "agent.completed"));
    assert.equal(restartedStore.append(event("EVT-095-2", "agent.completed")).accepted, false);
    assert.throws(() => restartedStore.append(event("EVT-095-2", "agent.failed")), { code: "EVENT_ID_CONFLICT" });
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function event(eventId, eventType) {
  return {
    event_id: eventId,
    event_type: eventType,
    timestamp: "2026-08-19T23:00:00Z",
    source: "agent-runtime",
    payload: { result: "recorded" },
    metadata: { project_id: "PROJECT-095", task_id: "TASK-095" }
  };
}
